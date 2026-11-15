# n8n setup: build it yourself

You build these workflows in your own n8n, by hand, so nothing runs (or burns executions) until you choose to. The paste-ready code for every Code node is in `dist/n8n/`. `terracorridor.json` is a reference only: open it to copy node settings, or import it if you decide to, but nothing here creates or runs workflows for you.

## Build order (cheapest first, each step testable on its own)

1. **Dashboard page (0 API calls).** Webhook (GET, path `terracorridor/map`, respond using Respond to Webhook node) > Code node returning `{ html }` with the contents of `dist/dashboard.html` > Respond to Webhook (text, header `Content-Type: text/html`). Add `<script>window.TC_API = location.origin + location.pathname.replace(/\/map\/?$/, "")</script>` after the Leaflet script tag. Until the corridor API exists, open `dist/dashboard-demo.html` locally instead.
2. **Human actions and work orders (0 API calls).** Webhook (POST `terracorridor/action`) > Code "Validate, log and create work order" (copy from the reference JSON; it includes the engine) > Respond to Webhook (first incoming item) > Code "Only new work orders" > Send Email and/or Slack (see below). Needs a saved corridor (step 4) before approvals work.
3. **Corridor API (0 API calls).** Webhook (GET `terracorridor/corridor`) > Code "Read corridor" > Respond.
4. **Engine run (about 51 API calls per full run for 17 cells, plus 1 + one per river crossing).** Manual Trigger first; add the Schedule Trigger only when it works. Route config > Segment route (`dist/n8n/01-segment-route.js` logic) > Group into 10 km cells > HTTP Open-Meteo archive > Crypto SHA-256 > HTTP CMIP6 climate > Crypto SHA-256 > HTTP Elevation > HTTP NASA POWER > HTTP Overpass waterways (Execute Once) > Code "Find crossings" (Execute Once) > HTTP GloFAS river flow > Code "Score corridor". Test it on 2 cells first: in Route config, cut `ROUTE` to its first ~20 points.
5. **AI explanations (one model call per amber or red segment, capped at 15).** Explanation prompts > HTTP to your model > Attach explanations.

Static data (where results and the audit log live) only persists on production runs, so activate the workflow and call the production webhook URLs when you test steps 2 to 5.

## What each branch does

| Branch | Nodes | Notes |
| --- | --- | --- |
| Engine run | Schedule / Manual / POST run > Route config > Segment route > Group into 10 km cells > Open-Meteo archive > SHA-256 > CMIP6 climate > SHA-256 > Elevation > NASA POWER > Overpass waterways > Find crossings > GloFAS river flow > Score corridor > Explanation prompts > AI explain > Attach explanations | One API call per 10 km cell, not per km. Archive and climate calls include minimum humidity (wildfire weather). **Overpass waterways** runs once for the route's bounding box; **Find crossings** (once) returns one item per river, stream or canal crossing; **GloFAS river flow** is one call per crossing (1995 to 2025 daily discharge, for peak flow). Every raw climate response is hashed; each segment stores the hashes it was built from. |
| Corridor API | GET corridor > Read corridor > Respond | Returns the saved corridor, the last 50 audit entries and every work order, so the dashboard shows decisions after a reload. |
| Dashboard | GET map > Dashboard HTML > Respond page | Same page as `dist/dashboard.html`, with `window.TC_API` pointed at this workflow. |
| Human actions | POST action > Validate, log and create work order > Respond > Only new work orders > Email / Slack | Only approve, reject and override are accepted; an override without a reason is refused. **Approve** builds the work order in n8n from the stored corridor (the browser only names the segment): priority from the tier (red P1 due in 14 days, amber P2 in 60), a checklist from the score's top drivers, location link, estimated cost. **Reject** cancels it. Both are logged. |

### What happens when someone presses Approve

1. The dashboard posts `{ action: "approve_work_order", segment, details: { stop } }`.
2. n8n checks it, builds the work order with `ENGINE.workOrder`, saves it in static data (`workOrders`) and adds an audit entry.
3. n8n answers with the work order; the dashboard shows it (ID, priority, due date, checklist) and lists it on the Work orders page.
4. After answering, **Only new work orders** passes it to **Email the field crew** and **Post to Slack**. Both ship **disabled**: pick one, add its credential, set `WORK_ORDER_TO` / `WORK_ORDER_FROM` (email) or the channel (Slack), and enable it. The message body is `ENGINE.workOrderText`.

Without n8n (the demo file), the dashboard builds the same work order locally and keeps it in that browser.

## Lane to-dos

- **Lane B, route:** replace `ROUTE` and `SUBSTATIONS` in **Route config** with a real pipeline from Overpass (`way["man_made"="pipeline"](bbox); out geom;`), and set `SYNTHETIC_ROUTE = false`.
- **Lane B, NDVI:** add Copernicus OAuth (client credentials) and a Statistical API call per segment; the parsing code is ready in `dist/n8n/04-ndvi.js`. Until then NDVI is left out and the score re-weights the other factors.
- **Lane A, ML:** after `ml/train.py`, paste `ml/model.json` into `MODEL` in **Score corridor**.
- **Lane D, deliver work orders:** enable **Email the field crew** or **Post to Slack** with a credential, then approve one red kilometre on camera and show the message arriving.

## Rate limits

Open-Meteo's free tier is limited per IP. A full run is about 17 archive + 17 climate + 17 elevation calls, plus 1 Overpass call and 1 flood call per river crossing. Save one good run's responses (`data/cache/`) so the demo never depends on the network.
