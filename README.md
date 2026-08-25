# BSVKey name index — on GitHub (Actions + Pages)

A **free, serverless** name+page indexer for BSVKey. A scheduled GitHub Action scans the
on-chain CHOST name registry **and each owner's published pages**, then publishes a static
**`docs/names.json`** which **GitHub Pages** serves over a CDN:

```json
{ "schema": "bsvkey-names/2", "names": {
    "myname": { "owner": "1Addr…", "txid": "<name-claim tx>", "page": "<page tx or null>" } } }
```

Because each name carries its **`page`** transaction id, BSVKey resolves a site in **one
fetch** (name → page tx → HTML) instead of scanning a wallet's whole history. It still
falls back to a trustless on-chain scan if the index is unavailable.

No server, no dependencies (Node 18+ built-in `fetch`).

## What's here
```
scripts/build-index.js        one-shot scanner → writes docs/names.json
.github/workflows/index.yml   cron (every 15 min) + manual run; commits names.json
docs/names.json               the published index (ships pre-built with your 53 names)
docs/index.html               a tiny status/lookup page
```

## Setup (once)
1. Create a **new GitHub repo** and push these files to it (root of the repo).
2. **Settings → Pages** → *Build and deployment* → Source: **Deploy from a branch**,
   Branch: **main**, Folder: **/docs** → Save.
   Your index is now at:
   `https://<your-user>.github.io/<repo>/names.json`
   (and a status page at `https://<your-user>.github.io/<repo>/`).
3. **Settings → Actions → General** → Workflow permissions → **Read and write** (so the
   Action can commit the refreshed `names.json`).
4. *(Optional, recommended)* **Settings → Secrets and variables → Actions → New secret**
   named `WOC_API_KEY` with a free WhatsOnChain API key — makes scans faster and avoids
   rate limits as the registry grows.
5. The Action runs every ~15 min; trigger it now from the **Actions** tab → *Build BSVKey
   name index* → **Run workflow**.

## Point BSVKey at it
In BSVKey's `index.html`, set near the top of the script:
```js
const NAME_INDEX_JSON = 'https://<your-user>.github.io/<repo>/names.json'
```
Redeploy the site. Name resolution + "Show my assets" now use the snapshot instantly,
and fall back to the on-chain scan automatically if the snapshot can't be reached.

## Notes
- **Freshness** = the cron cadence (~15 min). A brand-new claim shows up on the next run.
- **Scale:** one `names.json` is fine for tens of thousands of names. Beyond that, shard by
  first character or move to the always-on `bsvkey-indexer` (dynamic API). The
  `name → owner` contract is identical either way.
- Keep `REGISTRY_ADDRESS` (in the workflow env) identical to the app's, or they'll disagree.
- The scan is **incremental** — `actions/cache` restores the tx cache between runs, so only
  new registry transactions are fetched.
