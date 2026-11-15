# Backend integration notes

What the integration pass changed, and what it could not check. Written Sat Nov 14 2026.

## What was wrong

- **Three n8n instances.** W1 and W2 came from one, WF3 and WF4 from a second, W5 from a third. Table IDs and workflow IDs inside the exports pointed at nothing in the other instances. All workflows now reference tables by name, `workflows/wiring.json` holds your IDs, and `scripts/wire-workflows.js` rewrites every export.
- **Two table families.** WF3 and WF4 read `tc_predictions`, `tc_segments` and `tc_baselines`. Nothing wrote them. W2 writes `corridor_predictions` and `corridor_baselines`, with different columns (`horizon_years` 5 or 10 instead of `y5` or `y10`, `risk_score`, `cell_key`, `rain_p95_mm`). WF3 and WF4 now read the W2 tables. Near-term state and tier overrides live in a new `corridor_watch` table. Work orders and the audit log are `corridor_work_orders` and `corridor_audit`.
- **W5 saw nothing from W2.** Its adapter expected one prediction row per segment with `risk10_tier`. W2 writes two rows per segment. Every segment would have scored `unverified`. The adapter now pivots the W2 rows and reads slope and NDVI from `corridor_baselines`.
- **W5 under-counted buildable land by about 15%.** It used `2 x (200 - 30) m` of strip. W1 draws the strip 200 m wide starting 30 m out, and `src/engine.js` uses 200 m (98.8 acres per km). W5 now uses 200 m. **Mismatch since merging `main`:** the engine now leases a `buildStripM` strip (60 m by default), not the whole study area, so the dashboard's Build tab shows about 14.8 acres per km while W5's `corridor_build` rows still use the 200 m strip. The dashboard recomputes build scores itself, so it is unaffected, but W5's MW figures are about 6.7 times the dashboard's. Align W5's strip width before quoting W5 numbers.
- **Nothing served the dashboard.** The dashboard calls `GET /corridor`. Only the legacy workflow answered. The new API workflow does, from the Data tables.
- **A red segment could never get a work order.** WF4 says red always gets one, but only WF3 called it, and only on heavy forecast rain. W2 never calls WF4. The first fix sent every red segment to WF4; with the live thresholds that would have drafted 23 orders at once. **Superseded Nov 15:** a long-range tier is now a planning signal only. The manager requests inspections from the dashboard, and WF3 proposes a draft only for near-term heavy weather on flagged ground (dry run on, cap 3).
- **W1's hand-off to W2 had a blank workflow ID.** Filled in with W2's ID from your instance.
- **`terracorridor.json` moved to `workflows/legacy/`.** It uses the same webhook paths as WF4 and the API workflow, so importing all of them together breaks activation.

## Checked here

`npm test` runs the real Code-node source from the exports with n8n's globals mocked: WF3 flags the right segments from W2-shaped rows, WF4 builds work orders from WF3 output, WF4 accepts the exact payloads the dashboard sends, the W5 adapter reads W2 rows, and the dashboard's own engine consumes the API feed. `npm run validate` checks every export (JSON, connections, node references, Code node syntax).

## Not checked (needs a real n8n run)

- Importing the new workflow and the edited exports. Credentials must be picked again on import.
- Data table type inference on CSV import. If a column comes in as text, change it in the table.
- WF3's Open-Meteo forecast call from n8n Cloud (see `workflows/README.md`).
- Anything in W6. It is not in the repo.

## Audit pass, Nov 15 2026 (what changed and what was verified live)

- **Thresholds.** Live W2 Config had been set to full score at +15% and red above 50, which turned all 23 segments red at 10 years. Now +50%, amber 40, red 65 in W2, the engine and the API feed. Reasoning and numbers: `docs/THRESHOLDS.md`.
- **Four hazards in n8n.** W2 scored ground failure only, so the dashboard's crossing, wildfire and drought rows were empty. W2 now scores all four (same rules as `src/engine.js`) and stores them in `corridor_predictions.hazards_json`, with a status line for any hazard it could not score. New columns: `hazard`, `ground_score`, `hazards_json` on corridor_predictions, `crossings_json` on corridor_baselines.
- **wiring.json is filled in** from the live instance. All 11 tables exist there.
- **Solar strip width.** The engine leases a 60 m strip; W5's `corridor_build` rows still assume the 200 m study strip. `corridor_build` is empty in the live instance, so the dashboard only shows its own 60 m figures. Do not quote W5 MW or revenue numbers until W5 is aligned.
- **Solar energy units.** `mwhYr = MW x irradiance (kWh/m2/day) x 365 x performance ratio` is the peak-sun-hours method: 1 kWh/m2/day is one hour at the 1 kW/m2 rating condition, so MW x hours x 365 is MWh. It uses horizontal irradiance, not plane-of-array, so it is indicative.
- **Stale work orders.** The live `corridor_work_orders` table holds 3 rows for `seg_0d3a534ba42860fc`, a segment from the earlier route that no longer exists. One is still `pending_approval` with a waiting WF4 execution. The feed ignores them. Left in place (deleting data needs the owner).
- **Live W5 differs from the repo export** in several Code nodes (a teammate's newer edits). Not touched.

## Gemini on the AI nodes (live setup, Nov 14)

The live n8n runs W2, WF4 and W5 on Google Gemini (`models/gemini-3.5-flash`, free AI Studio key, credential type "Google Gemini(PaLM) Api") instead of Anthropic or OpenAI. The exports in this repo still carry the original model nodes; swap in `lmChatGoogleGemini` and pick your credential.

- **Set Max Output Tokens to 4000 on the WF4 summary node.** Gemini 3.5 Flash spends part of the output budget on thinking. At 400 the work order summary came back as a fragment of the model's reasoning; at 1500 it was clean but cut off mid-word; at 4000 it is two complete sentences.
- If you still see cut-off or reasoning text, use `models/gemini-3.5-flash-lite`.
- Free-tier content may be used by Google to improve its products. The inputs here are public weather data and a fictional corridor.
