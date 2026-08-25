/*
 * BSVKey static name-index builder (for GitHub Actions).
 * One-shot: scans the on-chain CHOST name registry and writes docs/names.json
 * (a first-claim-wins name -> owner map) which GitHub Pages serves over a CDN.
 * Incremental via a tx cache (.cache/txcache.json) restored by actions/cache.
 * Zero dependencies: Node 18+.
 */
'use strict'
const fs = require('fs')
const path = require('path')

const NETWORK = (process.env.NETWORK || 'main') === 'test' ? 'test' : 'main'
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS || '1G6sLZX7FEsho13aei7iVygWaJhrSXDsrM'
const WOC_API_KEY = process.env.WOC_API_KEY || ''
const THROTTLE_MS = parseInt(process.env.THROTTLE_MS || (WOC_API_KEY ? '40' : '150'), 10)
const OUT = process.env.OUT || 'docs/names.json'
const CACHE = process.env.CACHE || '.cache/txcache.json'
const CHOST_PREFIX = 'CHOSTv1'
const API = `https://api.whatsonchain.com/v1/bsv/${NETWORK}`
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function mkdirp(f){ fs.mkdirSync(path.dirname(f), { recursive: true }) }
function loadCache(){ try { return new Map(Object.entries(JSON.parse(fs.readFileSync(CACHE, 'utf8')))) } catch { return new Map() } }
function saveCache(m){ mkdirp(CACHE); fs.writeFileSync(CACHE, JSON.stringify(Object.fromEntries(m))) }

async function woc(p){ const headers = WOC_API_KEY ? { 'woc-api-key': WOC_API_KEY } : {}
  for (let i = 0; i < 5; i++){ const r = await fetch(API + p, { headers })
    if (r.status === 429){ await sleep(1500 * (i + 1)); continue }
    if (!r.ok) throw new Error(r.status + ' ' + p)
    await sleep(THROTTLE_MS); const t = await r.text(); try { return JSON.parse(t) } catch { return t } }
  throw new Error('rate-limited: ' + p) }
async function getHistory(addr){
  try { let out = [], token = null, guard = 0
    do { const j = await woc(`/address/${addr}/confirmed/history?limit=100${token ? '&token=' + token : ''}`)
      const rows = Array.isArray(j) ? j : (j.result || [])
      out = out.concat(rows.map(r => ({ txid: r.tx_hash, height: r.height || 0 })))
      token = (j && j.nextPageToken) || null } while (token && ++guard < 1000000)
    if (out.length) return out } catch {}
  const j = await woc(`/address/${addr}/history`); const rows = Array.isArray(j) ? j : (j.result || [])
  return rows.map(r => ({ txid: r.tx_hash, height: r.height || 0 })) }

function scriptPushesFromHex(hex){ const s = String(hex || '').toLowerCase(); const pushes = []; let i = 0, saw = false
  while (i + 2 <= s.length){ const op = parseInt(s.substr(i, 2), 16); i += 2
    if (!saw){ if (op === 0x6a) saw = true; continue }
    let len = 0
    if (op >= 0x01 && op <= 0x4b) len = op
    else if (op === 0x4c){ len = parseInt(s.substr(i, 2), 16) || 0; i += 2 }
    else if (op === 0x4d){ len = parseInt((s.substr(i, 4).match(/../g) || []).reverse().join(''), 16) || 0; i += 4 }
    else if (op === 0x4e){ len = parseInt((s.substr(i, 8).match(/../g) || []).reverse().join(''), 16) || 0; i += 8 }
    else continue
    pushes.push(s.substr(i, len * 2)); i += len * 2 }
  return pushes }
const hx = (h) => { try { return Buffer.from(h, 'hex').toString('utf8') } catch { return '' } }
function nameRecordFromTx(t){ for (const o of (t.vout || [])){ const hex = ((o.scriptPubKey || {}).hex || '').toLowerCase()
  if (!/^(00)?6a/.test(hex)) continue; const p = scriptPushesFromHex(hex).map(hx)
  if (p[0] === CHOST_PREFIX && p[1] === 'NAME' && p[2] && p[3]) return { name: String(p[2]).toLowerCase(), owner: p[3] } } return null }

;(async () => {
  const cache = loadCache()
  const hist = await getHistory(REGISTRY_ADDRESS)
  hist.sort((a, b) => (a.height || 1e12) - (b.height || 1e12))   // oldest first (first-claim-wins)
  let fetched = 0
  for (const h of hist){ if (cache.has(h.txid)) continue
    try { const t = await woc(`/tx/hash/${h.txid}`); const rec = nameRecordFromTx(t)
      cache.set(h.txid, rec ? { name: rec.name, owner: rec.owner, height: h.height } : false); fetched++ }
    catch (e){ /* leave uncached; next run retries */ } }
  const names = {}
  for (const h of hist){ const c = cache.get(h.txid); if (c && c.name && !names[c.name]) names[c.name] = { owner: c.owner, txid: h.txid, height: c.height } }
  const out = { schema: 'bsvkey-names/1', network: NETWORK, registry: REGISTRY_ADDRESS, updated: new Date().toISOString(), count: Object.keys(names).length, names }
  mkdirp(OUT); fs.writeFileSync(OUT, JSON.stringify(out))
  saveCache(cache)
  console.log(`wrote ${OUT}: ${out.count} names (${fetched} new tx fetched, ${cache.size} cached)`)
})().catch(e => { console.error(e); process.exit(1) })
