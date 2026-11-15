# Backend integration notes

What the integration pass changed, and what it could not check. Written Sat Nov 14 2026.

## What was wrong

- **Three n8n instances.** W1 and W2 came from one, WF3 and WF4 from a second, W5 from a third. Table IDs and workflow IDs inside the exports pointed at nothing in the other instances. All workflows now reference tables by name, `workflows/wiring.json` holds your IDs, and `scripts/wire-workflows.js` rewrites every export.
- **Two table families.** WF3 and WF4 read `tc_predictions`, `tc_segments` and `tc_baselines`. Nothing wrote them. W2 writes `corridor_predictions` and `corridor_baselines`, with different columns (`horizon_years` 5 or 10 instead of `y5` or `y10`, `risk_score`, `cell_key`, `rain_p95_mm`). WF3 and WF4 now read the W2 tables. Near-term state and tier overrides live in a new `corridor_watch` table. Work orders and the audit log are `corridor_work_orders` and `corridor_audit`.
- **W5 saw nothing from W2.** Its adapter expected one prediction row per segment with `risk10_tier`. W2 writes two rows per segment. Every segment would have scored `unverified`. The adapter now pivots the W2 rows and reads slope and NDVI from `corridor_baselines`.
- **W5 under-counted buildable land by about 15%.** It used `2 x (200 - 30) m` of strip. W1 draws the strip 200 m wide starting 30 m out, and `src/engine.js` uses 200 m (98.8 acres per km). W5 now uses 200 m.
- **Nothing served the dashboard.** The dashboard calls `GET /corridor`. Only the legacy workflow answered. The new API workflow does, from the Data tables.
- **A red segment could never get a work order.** WF4 says red always gets one, but only WF3 called it, and only on heavy forecast rain. W2 never calls WF4. WF3 now sends every red and red-uncertain segment to WF4, even when the forecast is quiet or failed.
- **W1's hand-off to W2 had a blank workflow ID.** Filled in with W2's ID from your instance.
- **`terracorridor.json` moved to `workflows/legacy/`.** It uses the same webhook paths as WF4 and the API workflow, so importing all of them together breaks activation.

## Checked here

`npm test` runs the real Code-node source from the exports with n8n's globals mocked: WF3 flags the right segments from W2-shaped rows, WF4 builds work orders from WF3 output, WF4 accepts the exact payloads the dashboard sends, the W5 adapter reads W2 rows, and the dashboard's own engine consumes the API feed. `npm run validate` checks every export (JSON, connections, node references, Code node syntax).

## Not checked (needs a real n8n run)

- Importing the new workflow and the edited exports. Credentials must be picked again on import.
- Data table type inference on CSV import. If a column comes in as text, change it in the table.
- WF3's Open-Meteo forecast call from n8n Cloud (see `workflows/README.md`).
- Anything in W6. It is not in the repo.

## Decision still open: every segment scores green

The W2 Config node sets `ratio_full_score_increase` to 0.5, so a segment needs +50% more extreme-rain days to max out that factor. On the demo corridor nothing gets close, so there are no amber or red segments, no explanations, no work orders and nothing to override in the demo. Options: lower it to about 0.25 (state it as our assumption on the dashboard), or pick a bbox with steeper ground in W1. This changes the headline numbers, so the team should choose it, not a script.
