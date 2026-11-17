# TerraCorridor platform (rewrite 2)

Built on 2026-11-16 from the scored strategy doc. This page says what exists, what it runs on, and what is still a guess.

## What changed

The geohazard dashboard is kept. Around it there is now one record per kilometre that carries four things together, with one approval trail:

| Module | Code | What it does today |
| --- | --- | --- |
| Class location (lead) | `src/classlocation.js` | Counts dwellings in a sliding 1.6 km window, 200 m each side. Forecasts a class change from permits, dates it, and starts the regulator's clock (CER six months, PHMSA 24 months). |
| Decision | `src/decision.js` | Lists every way to deal with a class change, with cost, months, material lead time and whether it meets the deadline. Names the assumption the answer hinges on. |
| Geohazard | `src/engine.js` (unchanged), read by `src/platform.js` | The existing four-hazard score becomes one part of the record. |
| Land obligations | `src/obligations.js` | Reads obligations from a land-system export, pins them to kilometres, checks every work order. AI extraction is kept only when quoted word for word. |
| Encroachment | `src/platform.js` | Flags reported digging or structures inside the 30 m prescribed area. |
| Field feedback (W7) | `src/feedback.js` | A crew finding updates every module it touches and is paired with what the system predicted. |
| Ledger and evidence | `src/ledger.js` | One approval gate. Each decision is chained with SHA-256. Evidence pack per kilometre. |
| Exports | `src/export.js` | Work orders CSV (Maximo, SAP), segments GeoJSON (Esri), draft plan PDF, evidence pack PDF. |
| The join | `src/platform.js`, `src/segments.js` | Builds the record. A geohazard flag raises the cost of the integrity path. A path that breaks ground wakes the land obligations on that kilometre. |

Page: `web/platform.html` (built to `dist/platform.html` and `deploy/platform.html`). Open `dist/platform.html` in a browser; it needs no network.

## Why this is hard to copy

Building counts are a commodity. Three things here are not.

1. **It reads the future from free public records.** Building permits lead occupancy by a construction season. Development permits lead those. Plans in effect lead those. A satellite sees a roof after it exists.
2. **It joins obligations nobody else joins.** Class, ground, land terms and digging sit on the same kilometre and change each other's answers.
3. **It keeps the decision record.** What changed, which path was chosen, what it was estimated to cost, what it did cost, what the crew found. Hash-chained per kilometre. `prediction-vs-field.csv` is the labelled dataset that only exists because someone used the tool.

## Data sources (all free)

| Source in the strategy doc | Status here | Where |
| --- | --- | --- |
| Building permits | REAL. City of Edmonton open data, dataset `24uj-dj8v`. 1,202 permits adding 1,895 units within 200 m of the Edmonton demo line since 2009. | `data/cache/permits/` |
| Development permits (earlier signal) | REAL. Dataset `2ccn-pwtu`, 331 near the line since 2024. | same file |
| Building footprints | REAL. City of Edmonton rooflines, 2019, dataset `jpxi-a9a5`. 3,022 roofs of 60 m2 or more within 200 m. One survey date only. | same file |
| Community and development plans | REAL. Plans in Effect, dataset `jdmr-bidz`. Six plans touch the line. | same file |
| Rezoning and subdivision filings | NOT LOADED. Edmonton publishes subdivision applications for mature neighbourhoods only (`5mh4-z7dk`). No rezoning feed found yet. | |
| CER class location rule | Six-month plan deadline, from the CER Filing Manual, Guide E. | `src/classlocation.js` |
| PHMSA 2026 class change rule | Effective 16 March 2026. Integrity management alternative for Class 1 or 2 to Class 3. Due 16 March 2028 or 24 months after the change, whichever is later. Nine requirement areas from the PHMSA fact sheet. | `src/classlocation.js`, `src/decision.js` |
| Geohazard inputs (Open-Meteo, CMIP6, Sentinel-2, OSM) | REAL, unchanged from the existing build. | `data/snapshot/`, `data/corridors/` |
| Pandell (land agreements) | NOT CONNECTED. No public API or sample export. A CSV import with a column mapping is ready. Example rows are invented. | `data/obligations/` |
| CER commitment tracking tables | The extraction and the quote check are built and tested on an illustrative table. No real table is in the repo; paste one into W8. | `data/obligations/` |
| Encroachment (patrols, one-call, imagery) | NO FEED. Crew findings are the only source. | |
| Orbital Eye, Ecopia (paid counts) | Not used. The team asked for free sources only. | |
| Esri, Maximo, SAP | Export only: GeoJSON and CSV. No write-back. | `src/export.js` |

Refresh the Edmonton data from a laptop: `npm run fetch-permits -- data/snapshot/live-snapshot.json`, then `npm run build`. The first copy was pulled through a browser on 2026-11-16 with the same queries, because the build machine could not reach the portal; the script has not yet been run end to end.

## What the real data says (Edmonton demo line, 2026-11-16)

- One kilometre is forecast to change: km 5 to 6 could go from Class 1 to Class 2. Six roofs today, 23 dwellings with development permits and no building permits yet.
- One kilometre already changed: the window at km 6.8 to 8.4 had no roofs in the 2019 survey and has 417 permitted units since. Permits crossed the Class 2 line in early 2022 and the Class 3 line later that year.
- Replay: 2 of 2 changes were visible in issued permits 9 months before the estimated occupancy. **The 9 months is the assumed construction lag, not a measurement.** Do not quote it as a lead time until dated building counts replace the assumption.

The route is a public OpenStreetMap pipeline way. No operator is involved. Nothing here says this line carries gas or has a class location obligation.

## Looking ahead to 2035

`src/growth.js` treats growth as stages and runs 1,000 possible futures (seeded Monte Carlo, quarterly steps, to 2035-12-31). The page shows chances and date ranges, never one date. `CLASS.outlook` (permits, approvals, pace and plan scenarios) is kept for the n8n workflows and tests but no longer drives the page.

Each stage is measured from City of Edmonton records across the whole city, cached in `data/cache/growth/` with SHA-256:

| Stage | Measured | From |
| --- | --- | --- |
| Planned land starts building | Chance a 4 ha block inside a plan starts each year, by what is nearby: 34% next to a block started in the last two years, 9% with nothing within 600 m | 700 starts, 2009 on, on buildable land |
| Land that never builds | 45% of plan land in 27 mature plans never got a home (parks, roads, storm ponds, schools). Left out of the rates above | Plans in Effect plus building permits |
| Build-out | 90% of a block's homes within 3 years of its first permit; median 52 homes per block | 303 finished blocks |
| Approval to building permit | 97% convert, median 0.5 months | 10,101 matched development permits |
| Building permit to move-in | Median 8.5 months, houses and rowhouses separately | 8,231 homes with an occupancy date |

Apartment move-in (20 months) is still an assumption: too few have an occupancy date.

On the Edmonton line: km 5 to 6 has a 95% chance of Class 2 by 2035 (most likely early 2028; 8 in 10 of the futures that change fall between mid 2027 and late 2029) and 90% of Class 3. About 820 homes are added within 200 m of the line by 2035 on average.

**Hindcast.** Fitted only on records to the end of 2016, started from the line as it stood then, run to mid 2026. km 6 was given 92% and changed; km 5 was given 64% and did not. Per kilometre Brier score 0.055 over 14 kilometres. Per block it expected 4.6 of 16 planned blocks to start and 7 did, Brier 0.278 against 0.246 for one flat rate: **it picks the kilometre well but does no better than a flat rate at which block starts first.** One line, one hindcast.

**When to order pipe.** `DECISION.orderSignal` takes every simulated change date. The order window is pipe lead time plus build time minus the regulator's clock (8 + 12 - 6 = 14 months in Canada with the placeholders). It says order now if the chance of a change inside that window is above a threshold the user sets (50% by default), and otherwise gives the date when it will be. With a 24-month US clock the window is negative: order after the change.

**Not built.** A gradient-boosted model to explain which blocks start first needs lot-level features (roads, servicing, school sites) that are not loaded yet; the hindcast says that is where the error is. The model is JavaScript, not Python, so the page, the tests and the n8n Code nodes run the same code.

## What is a guess

- **CSA Z662 counting rules.** The standard is paywalled. Thresholds (11 and 46 dwelling units) and the 200 m by 1.6 km window follow 49 CFR 192.5. Confirm with a pipeline engineer.
- **Every cost in the decision module.** Placeholders, flagged in the code, the page and the draft PDF.
- **Apartment move-in time** (20 months). Houses and rowhouses are measured.
- **A roof is counted as one dwelling.** A duplex is one roof and two units. A crew count overrides the estimate.
- **Class 4** is not assessed. Tall roofs are listed as a prompt.
- **Pandell's export layout** and **Guide E's full list of required plan contents** were not seen. The draft plan leaves marked blanks.

## Cut

- **Score-to-probability money.** The Money page is out of the navigation and old links land on the overview. The dollar figures are off the segment report.
- **Solar (W5, Build page).** Out of the navigation and the segment report.
- `moneyForSegment`, `buildScore` and the W5 export are still in the repo because existing tests and the BC seed scripts read them. Removing them is a separate change for whoever owns those tests.
- Not started: 3D twin, data centre siting, commodity tax.

## n8n

Four workflows are generated from the tested modules by `scripts/make-platform-workflows.js`, the same way the dashboard feed is. They are exported with `active: false`.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| W6 Class location watch | Manual, and Mondays 06:00 | Segments, then open-data permits, then a class row per segment with the path comparison. A failed download writes `unverified`, never `no change`. |
| W7 Field feedback | `POST /terracorridor/finding` | Validates a finding, chains it into the ledger, saves it. Refuses bad input with a 400. |
| W8 Land obligations | Manual, and `POST /terracorridor/obligation-check` | Gemini extracts obligations from a pasted document; only quoted ones are saved, unverified. The webhook checks a work order. |
| W9 Approval gate and evidence | `POST /terracorridor/decide`, `GET /terracorridor/platform` | One gate for all modules. Refuses a decision with no name, or a rejection with no reason, or a broken chain. Serves the feed. |

To put them live in the team's instance:

1. Create five Data tables (all columns are strings):
   - `corridor_class`: segment_id, corridor_id, status, class_now, class_committed, class_possible, lower_bound, change_date, plan_due, units_json, evidence_json, decision_json, assessment_json, data_status, assessed_at
   - `corridor_class_baseline`: corridor_id, bin, roofs, tall_roofs
   - `corridor_obligations`: obligation_id, type, requirement, triggers, notice_hours, km_from, km_to, party, agreement, clause, quote, extracted_by, verified, verified_by, saved_at
   - `corridor_findings`: finding_id, segment_id, kind, module, also_json, value, note, within_prescribed_area, work_order_id, reported_by, reported_at
   - `corridor_ledger`: seq, hash, prev, type, segment_id, at, entry_json
2. Put the five table IDs in `workflows/wiring.json`, run `npm run platform-workflows`, then `npm run validate`.
3. Import the four JSON files. W8 points at the same Gemini credential as WF4.
4. Open the page with `?api=https://YOUR-INSTANCE.app.n8n.cloud/webhook/terracorridor` and decisions and findings go to n8n as well as the browser.

Not tested live: nothing above has run inside n8n. The tests run the real Code-node source with n8n's globals mocked (`test/platform.test.js`). Whether n8n Cloud can reach data.edmonton.ca is unknown.

Still to do on the existing workflows: W1 does not yet write the class assessment band as a polygon (the module computes it from the centreline), and the W2 scoring still lives in n8n Code nodes rather than a module.

## Tests

`npm test` runs 81 tests: the 54 that existed, 22 for the platform (`test/platform.test.js`) and 5 for the growth model and the order rule (`test/growth.test.js`).
