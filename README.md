# TerraCorridor

A self-running risk dashboard for pipeline corridors. Built for the UBC eProjects x n8n LOOP buildathon.

Every week n8n pulls 30 years of weather history, CMIP6 climate projections to 2036 and Sentinel-2 vegetation data for each kilometre of a pipeline right-of-way. It ranks where the ground is likely to fail in the next 5 to 10 years, prices what that risk costs, and shows which stable stretches could carry solar and storage. People approve, reject or override every action, and every decision is logged.

**AI explains. Rules (or a small, visible learned model) decide. People approve.**

## Problem

Weather-driven ground failures are rare but expensive, and operators often see them too late. In the 2020 Hillsboro, Kentucky rupture, the operator had already found the landslide and planned to fix it that summer; the slope failed first. Meanwhile most corridor land earns nothing beyond the lease.

## What it does

1. **Predict (5 and 10 years).** For each 1 km segment: observed baseline from the Open-Meteo archive (1995 to 2025), three CMIP6 models (MRI, EC-Earth, MPI) for 2026 to 2036, compared with each model's own history (delta method). Four natural hazards, each scored 0 to 100 on its own; a segment's level is its worst one (never a blend):
   - **Ground failure:** extreme-rain, freeze-thaw and wet-soil days vs baseline, Sentinel-2 NDVI trend, slope.
   - **River crossing:** only where the pipe crosses a mapped river, stream or canal (OpenStreetMap): waterway size, historical peak flow (Open-Meteo Flood API, GloFAS) and projected heavy-rain change.
   - **Wildfire weather:** change in fire-weather days (no rain, 25 °C or hotter, minimum humidity 35% or lower; two of the three models report humidity), how many there will be, and vegetation fuel.
   - **Drought:** change in dry-soil days (below the baseline's 10th percentile) and in each year's longest dry spell.

   Tier and model agreement per segment. Missing data means "unverified", never green; no crossing means "not applicable", never low.
2. **Price it and recommend.** Expected loss per segment, loss avoided by a targeted inspection, risk-based inspection savings, plus the operator's share of solar lease revenue. The Money page adds both halves, says whether to run the program, and names the assumption the answer hinges on. Every assumption is on a slider.
3. **Build layer.** Solar plus storage on a narrow panel strip (default 60 m total) outside the 30 m CER prescribed area: MW, MWh, lease revenue and the landowner partner's share, with a sunlight band on the map. Rising risk halves the build score.
4. **Humans in charge.** Approving a kilometre creates a work order (priority and due date from its risk, a checklist from its drivers) that n8n stores and can send by email or Slack. Reject cancels it; overrides need a reason. All of it goes to the audit log.

Real check (Nov 14, live APIs, a point in central Alberta): all three climate models agree extreme-rain days rise by 2036 (+7% to +37%, mean +26% vs each model's own history); wet-soil days +60% in the two models that report soil moisture.

## Honest numbers

On the 169 km demo corridor at $430k per failure (sourced average), with all four hazards modelled, pipeline protection alone is about $328k short over 10 years: more kilometres are at risk, so fewer qualify for lighter inspection. Leasing a 60 m panel strip beside the 28 km of stable pipeline at $400 an acre (both our conservative assumptions) brings the operator about $830k, so the combined program is about $500k ahead. It stays positive while the lease is above about $159 an acre. Even at $11.7M per failure (one sourced geohazard rupture), protection alone is about $20k short. The dashboard shows all of it; we do not hide the slider.

## Repo layout

```
src/engine.js            The whole engine: segmenting, baselines, projections, NDVI trend, risk, build, money. Pure JS.
test/                    Engine tests, dashboard feed tests, and tests that run the real Code-node JS from workflows/: npm test
scripts/make-demo.js     Synthetic demo corridor run through the real engine -> data/demo/corridor.json
scripts/build.js         Inlines the engine into dist/dashboard*.html and dist/n8n/*.js (Code node bodies)
scripts/make-workflow.js Generates the old single workflow, now in workflows/legacy/ (reference only)
scripts/make-api-workflow.js  Generates the dashboard feed workflow from src/dashboard-api.js
scripts/wire-workflows.js     Points every workflow at your n8n Data tables by name (workflows/wiring.json)
scripts/validate-workflows.js Checks every workflow export before import
scripts/fetch-climate-cells.js Laptop script that fills the weather cache when n8n Cloud is blocked by Open-Meteo
src/dashboard-api.js     Builds the dashboard JSON from the Data tables (the API workflow's Code node)
workflows/               The n8n exports W1 to W5 plus the API workflow. See workflows/README.md
web/dashboard.html       Dashboard source (Leaflet + Esri imagery)
dist/                    Built files. dashboard-demo.html opens in any browser with demo data
ml/features.js           Builds training data from PHMSA accidents + Open-Meteo history
ml/train.py              Logistic regression -> ml/model.json (paste into 05-score.js MODEL)
data/cache/              Real API responses saved for demo fallback
docs/                    Sources, disclosures, first-hour checks
```

## Quick start

```
npm test                 # engine tests
npm run demo             # rebuild synthetic demo data
npm run build            # rebuild dashboard and n8n node code
```

Open `dist/dashboard-demo.html` in a browser to see the dashboard with demo data.

In n8n: build the workflows by hand following `workflows/README.md` (Code node bodies are in `dist/n8n/`; `workflows/terracorridor.json` is a reference only).

## Data is labelled

The demo corridor is SYNTHETIC (illustrative route, simulated climate) and the page says so. The live n8n run uses real APIs. The operator name in any demo is fictional. See `docs/DISCLOSURES.md`.
