# Refreshing the hazard inputs (for a teammate, or tomorrow)

n8n Cloud's shared IP is refused by Open-Meteo and Overpass, so two inputs are fetched from a laptop and loaded into n8n with a small seed workflow. You need Node 18 or newer and this repo. No keys.

## Where things stand (Nov 15 2026)

| 10 km cell | Segments | Cached with humidity (v2)? |
| --- | --- | --- |
| 53.30_-113.50 | 1 | yes |
| 53.40_-113.50 | 6 | no, older cache (v1) |
| 53.40_-113.40 | 7 | no, older cache (v1) |
| 53.50_-113.40 | 9 | no, older cache (v1) |

Segments in a v1 cell still get ground-failure and crossing scores. Their wildfire and drought rows read "unavailable: no observed humidity in the cached baseline". Nothing is invented. Crossings are loaded for all 23 segments (6 cross a mapped stream).

## Finish the three remaining cells (about 5 minutes)

Open-Meteo's free tier allows roughly five cells a day per IP address, and the laptop that fetched the first ones is near its limit until 5 PM Pacific (midnight UTC). Use a different network (another laptop, or a phone hotspot) or wait.

```
git pull
npm run fetch-cells
```

It skips cells that are already v2, waits about a minute between downloads, saves after every cell, and can be re-run if it stops on a rate limit. When it ends it rewrites `workflows/TerraCorridor Seed - Hazard inputs.json`.

Then commit and push the two changed files (`data/cache/cells/trans-northern-cells.json` and the seed workflow), and in n8n:

1. Open the workflow **TerraCorridor Seed - Hazard inputs** (first time: create a new empty workflow). Ctrl+A, Delete. **⋯ → Import from URL**, paste the raw GitHub link to `workflows/TerraCorridor Seed - Hazard inputs.json` on `main`. Save. Do not publish it; it has a manual trigger only.
2. Press **Execute workflow** once. It upserts the cell rows and writes the crossings. It calls nothing external and can be run again safely.
3. Open **W2: Long-Range Engine** and press **Execute workflow**. About 2 minutes for 23 segments.
4. Reload the dashboard. Wildfire and drought rows now have scores on every segment.
5. Optional, to refresh the offline copy: `npm run snapshot -- https://chlooood.app.n8n.cloud/webhook/terracorridor`, then `npm run build`, commit, push.

## If the route changes

Run `npm run fetch-crossings -- https://chlooood.app.n8n.cloud/webhook/terracorridor` (OSM waterways against the new centreline), update `CORRIDOR_CELLS` at the top of `scripts/fetch-climate-cells.js` (the cell of a segment is its centre rounded to 0.1 degree, as `lat_lon` with two decimals), then follow the steps above.

## What not to do

- Do not edit rows in `corridor_climate_cells` by hand. Each row carries the SHA-256 of the raw download.
- Do not copy humidity or dry-soil numbers from one cell to another to fill the gaps.
- Do not switch `DRY_RUN` off in WF3 without reading `docs/THRESHOLDS.md`.
