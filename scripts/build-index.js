/*
 * BSVKey static name+page index builder (GitHub Actions).
 * Scans the on-chain CHOST registry: NAME claims (first-claim-wins) + XFER transfers
 * (honoured only if signed by the then-current owner) + each owner's published pages.
 * Output: docs/names.json  { names: { name: { owner, txid, page } } }
 *   owner = current owner after any transfers; txid = the record that set it;
 *   page  = the tx of the page that name serves (tagged page, else owner's default), or null.
 * Incremental via a tx cache (.cache/txcache.json). Zero deps: Node 18+.
 */
'use strict'
const fs = require('fs'); const path = require('path')
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
function loadCache(){ try { const j = JSON.parse(fs.readFileSync(CACHE, 'utf8')); return { reg: j.reg || {}, pub: j.pub || {} } } catch { return { reg: {}, pub: {} } } }
function saveCache(c){ mkdirp(CACHE); fs.writeFileSync(CACHE, JSON.stringify(c)) }

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
// A registry tx → {kind:'name',name,owner} | {kind:'xfer',name,newOwner} | null
function registryRecordFromTx(t){ for (const o of (t.vout || [])){ const hex = ((o.scriptPubKey || {}).hex || '').toLowerCase()
  if (!/^(00)?6a/.test(hex)) continue; const p = scriptPushesFromHex(hex).map(hx)
  if (p[0] !== CHOST_PREFIX) continue
  if (p[1] === 'NAME' && p[2] && p[3]) return { kind: 'name', name: String(p[2]).toLowerCase(), owner: p[3] }
  if (p[1] === 'XFER' && p[2] && p[3]) return { kind: 'xfer', name: String(p[2]).toLowerCase(), newOwner: p[3] } } return null }
function pubRecordFromTx(t){ for (const o of (t.vout || [])){ const hex = ((o.scriptPubKey || {}).hex || '').toLowerCase()
  if (!/^(00)?6a/.test(hex)) continue; const p = scriptPushesFromHex(hex).map(hx)
  if (p[0] === CHOST_PREFIX && p[1] === 'PUB' && p[2] != null) return { site: (p[4] || '').toLowerCase() } } return null }
// The address that signed tx `t` (its first input's previous-output address). Authorizes transfers.
async function signerOfTx(t){ const vin = (t.vin || [])[0]; if (!vin || !vin.txid || vin.vout == null) return null
  try { const prev = await woc(`/tx/hash/${vin.txid}`); const o = (prev.vout || [])[vin.vout]; const a = o && o.scriptPubKey && o.scriptPubKey.addresses; return (a && a[0]) || null } catch { return null } }

;(async () => {
  const cache = loadCache()
  // 1) registry records (NAME + XFER), oldest first
  const reg = await getHistory(REGISTRY_ADDRESS); reg.sort((a, b) => (a.height || 1e12) - (b.height || 1e12))
  let fetched = 0
  for (const h of reg){ if (h.txid in cache.reg) continue
    try { const t = await woc(`/tx/hash/${h.txid}`); const rec = registryRecordFromTx(t); fetched++
      if (rec && rec.kind === 'xfer') rec.signer = await signerOfTx(t)   // resolve signer now (needs the tx)
      cache.reg[h.txid] = rec || false } catch {} }
  // 2) apply ownership: first NAME = original owner; each XFER applies only if signed by current owner
  const names = {}
  for (const h of reg){ const c = cache.reg[h.txid]; if (!c) continue
    if (c.kind === 'name'){ if (!names[c.name]) names[c.name] = { owner: c.owner, txid: h.txid } }
    else if (c.kind === 'xfer'){ const cur = names[c.name]; if (cur && c.signer && c.signer === cur.owner){ cur.owner = c.newOwner; cur.txid = h.txid } } }
  // 3) pages per (current) owner
  const owners = [...new Set(Object.values(names).map(n => n.owner))]
  const ownerPages = {}
  for (const owner of owners){ let hist; try { hist = await getHistory(owner) } catch { hist = [] }
    hist.sort((a, b) => (b.height || 1e12) - (a.height || 1e12))
    const pg = { default: null, sites: {} }
    for (const h of hist){ if (!(h.txid in cache.pub)){ try { const t = await woc(`/tx/hash/${h.txid}`); const r = pubRecordFromTx(t); cache.pub[h.txid] = r ? { site: r.site } : false; fetched++ } catch { continue } }
      const c = cache.pub[h.txid]; if (!c) continue
      if (c.site){ if (!pg.sites[c.site]) pg.sites[c.site] = h.txid } else if (!pg.default) pg.default = h.txid }
    ownerPages[owner] = pg }
  for (const [name, rec] of Object.entries(names)){ const pg = ownerPages[rec.owner] || { default: null, sites: {} }; rec.page = pg.sites[name] || pg.default || null }

  const out = { schema: 'bsvkey-names/3', network: NETWORK, registry: REGISTRY_ADDRESS, updated: new Date().toISOString(), count: Object.keys(names).length, names }
  mkdirp(OUT); fs.writeFileSync(OUT, JSON.stringify(out)); saveCache(cache)
  console.log(`wrote ${OUT}: ${out.count} names, ${owners.length} owners, ${fetched} new tx fetched`)
})().catch(e => { console.error(e); process.exit(1) })
