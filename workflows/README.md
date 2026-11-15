# n8n workflows

These exports run as one system in **one** n8n instance. They share Data tables, so the order and the table names matter.

```
W1 Corridor Setup ──(Execute Workflow)──> W2 Long-Range Engine ──> corridor_predictions, corridor_baselines
                                                                         │
                         WF3 Near-term watch (daily 06:00) <─────────────┤  reads predictions, checks the 16-day forecast
                              │  red, or amber with heavy rain                │
                              └──(Execute Workflow)──> WF4 Work orders ───────┤  AI drafts the order, human approves, tier overrides
                                                                              │
                         W5 Build Layer + weekly report (Mon 06:30) <─────────┘  solar and storage score, report with approval step

API - Dashboard feed   GET  /webhook/terracorridor/corridor   reads every table, returns the JSON the dashboard draws
WF4                    POST /webhook/terracorridor/action     approve_work_order, reject_work_order, override_tier
```

| File | Job | Trigger | Reads | Writes |
| --- | --- | --- | --- | --- |
| `W1_ Corridor Setup.json` | Pull the pipeline route, cut 1 km segments, hash the source | monthly, manual | OSM Overpass | corridor_sources, corridor_segments |
| `W2_ Long-Range Engine.json` | Weather baseline, CMIP6, Sentinel-2 NDVI, elevation, score, AI explanation | called by W1, weekly | corridor_segments | corridor_baselines, corridor_predictions, corridor_climate_cells, corridor_sources |
| `TerraCorridor WF3 - Near-term watch.json` | 16-day forecast against each cell's baseline thresholds for flagged segments | daily | corridor_predictions, corridor_baselines, corridor_watch | corridor_watch, corridor_audit |
| `TerraCorridor WF4 - Work orders and approvals.json` | Work order per red segment, human approve or reject, tier override | called by WF3, dashboard POST | corridor_work_orders, corridor_watch | corridor_work_orders, corridor_watch, corridor_audit |
| `TerraCorridor W5 - Solar + Storage Build Layer and Weekly Report.json` | Build score, MW, lease revenue, weekly report with approval | weekly, manual, webhook | corridor_segments, corridor_predictions, corridor_baselines, corridor_watch, corridor_work_orders | corridor_build, corridor_build_config, corridor_reports |
| `TerraCorridor API - Dashboard feed.json` | Serves the dashboard | GET webhook | everything above | nothing |
| `legacy/terracorridor.json` | The old single-workflow design. Reference only. Do not import it next to the others: it uses the same webhook paths | | | |

Generated: the API workflow comes from `src/dashboard-api.js` via `node scripts/make-api-workflow.js`. Edit the source, not the Code node.

## Get it running (in the order that works)

Do this in the n8n instance where W1 and W2 already run. The exports came from three different n8n instances, so table and workflow IDs inside them do not match yours until you wire them (step 2).

1. **Create the 6 missing Data tables.** n8n, Data tables, Create, Import CSV. Use the files in `data/tables/` (corridor_build, corridor_build_config, corridor_reports, corridor_watch, corridor_work_orders, corridor_audit). Delete the sample row after each import. Column lists are in `docs/DATA_TABLES.md`.
2. **Wire the IDs.** Open each new table, copy the ID from the URL (`.../data-tables/<ID>`) into `workflows/wiring.json`, then run `node scripts/wire-workflows.js`. Every workflow now points at your tables.
3. **Import WF4 first.** Workflows, Import from file. Open it, pick your own credential on the AI node, Publish it. Copy its ID from the URL into `wiring.json` under `workflows`, run `node scripts/wire-workflows.js` again.
4. **Import WF3, W5 and the API workflow.** Pick credentials on any node that asks. Publish the API workflow (its webhook only exists once published).
5. **Check it.** `node scripts/validate-workflows.js --strict` must say `no errors`. Then run W1 (W2 follows), then run WF3 manually once.
6. **Open the dashboard** with your webhook base: `dist/dashboard.html?api=https://YOUR-INSTANCE.app.n8n.cloud/webhook/terracorridor`

You do not need to re-import W1 or W2 if they already run. The repo copy of W1 now has the W2 hand-off ID filled in.

## Things that will bite you

- **Open-Meteo blocks n8n Cloud's shared IP** on the free tier (HTTP 429). W2 works around it with the `corridor_climate_cells` cache filled by `scripts/fetch-climate-cells.js` from a laptop. WF3's 16-day forecast has no cache. If it fails, WF3 marks the cell `unverified`, never `clear`, and **red segments still get a work order**. Fix for the demo: run WF3 from a network that is not blocked, or use an Open-Meteo API key.
- **AI nodes use n8n "Gateway credits"** (W2 Claude Haiku, WF4 and W5 OpenAI). All three fail open: W2 leaves the explanation empty, WF4 writes a fixed-template summary, W5 falls back without the narrative. Nothing stops.
- **W2 only explains amber and red.** If every segment is green, there are no explanations, no work orders and nothing to override. See the threshold note in `docs/BACKEND_NOTES.md`.
- **Overrides are per horizon.** A tier override at `y10` does not change the `y5` tier.
- **W6 is not in the repo.** W5's shared adapter block says there is an identical copy in W6. If W6 exists, run its copy of the block through `scripts/wire-workflows.js` too (it matches on the `integrations` object).
- Each export has `active` set as its author left it. n8n ignores that on import. Publish what you need.
