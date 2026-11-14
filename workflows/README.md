# n8n setup: build it yourself

You build these workflows in your own n8n, by hand, so nothing runs (or burns executions) until you choose to. The paste-ready code for every Code node is in `dist/n8n/`. `terracorridor.json` is a reference only: open it to copy node settings, or import it if you decide to, but nothing here creates or runs workflows for you.

## Build order (cheapest first, each step testable on its own)

1. **Dashboard page (0 API calls).** Webhook (GET, path `terracorridor/map`, respond using Respond to Webhook node) > Code node returning `{ html }` with the contents of `dist/dashboard.html` > Respond to Webhook (text, header `Content-Type: text/html`). Add `<script>window.TC_API = location.origin + location.pathname.replace(/\/map\/?$/, "")</script>` after the Leaflet script tag. Until the corridor API exists, open `dist/dashboard-demo.html` locally instead.
2. **Human actions (0 API calls).** Webhook (POST `terracorridor/action`) > Code "Validate and log action" (copy from the reference JSON) > Respond to Webhook (first incoming item).
3. **Corridor API (0 API calls).** Webhook (GET `terracorridor/corridor`) > Code "Read corridor" > Respond.
4. **Engine run (about 51 API calls per full run for 17 cells).** Manual Trigger first; add the Schedule Trigger only when it works. Route config > Segment route (`dist/n8n/01-segment-route.js` logic) > Group into 10 km cells > HTTP Open-Meteo archive > Crypto SHA-256 > HTTP CMIP6 climate > Crypto SHA-256 > HTTP Elevation > HTTP NASA POWER > Code "Score corridor". Test it on 2 cells first: in Route config, cut `ROUTE` to its first ~20 points.
5. **AI explanations (one model call per amber or red segment, capped at 15).** Explanation prompts > HTTP to your model > Attach explanations.

Static data (where results and the audit log live) only persists on production runs, so activate the workflow and call the production webhook URLs when you test steps 2 to 5.

## What each branch does

| Branch | Nodes | Notes |
| --- | --- | --- |
| Engine run | Schedule / Manual / POST run > Route config > Segment route > Group into 10 km cells > Open-Meteo archive > SHA-256 > CMIP6 climate > SHA-256 > Elevation > NASA POWER > Score corridor > Explanation prompts > AI explain > Attach explanations | One API call per 10 km cell, not per km. Every raw response is hashed; each segment stores the hashes it was built from. |
| Corridor API | GET corridor > Read corridor > Respond | Returns the saved corridor plus the last 50 audit entries. |
| Dashboard | GET map > Dashboard HTML > Respond page | Same page as `dist/dashboard.html`, with `window.TC_API` pointed at this workflow. |
| Human actions | POST action > Validate and log action > Respond | Only approve, reject and override are accepted. An override without a reason is refused. |

## Lane to-dos

- **Lane B, route:** replace `ROUTE` and `SUBSTATIONS` in **Route config** with a real pipeline from Overpass (`way["man_made"="pipeline"](bbox); out geom;`), and set `SYNTHETIC_ROUTE = false`.
- **Lane B, NDVI:** add Copernicus OAuth (client credentials) and a Statistical API call per segment; the parsing code is ready in `dist/n8n/04-ndvi.js`. Until then NDVI is left out and the score re-weights the other factors.
- **Lane A, ML:** after `ml/train.py`, paste `ml/model.json` into `MODEL` in **Score corridor**.
- **Lane D, approvals by email or Slack:** optional. The dashboard buttons already give a human-in-the-loop step and an audit trail.

## Rate limits

Open-Meteo's free tier is limited per IP. A full run is about 17 archive + 17 climate + 17 elevation calls. Save one good run's responses (`data/cache/`) so the demo never depends on the network.
