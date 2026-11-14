# TerraCorridor

A self-running risk dashboard for pipeline corridors. Built for the UBC eProjects x n8n LOOP buildathon.

Every week n8n pulls 30 years of weather history, CMIP6 climate projections to 2036 and Sentinel-2 vegetation data for each kilometre of a pipeline right-of-way. It ranks where the ground is likely to fail in the next 5 to 10 years, prices what that risk costs, and shows which stable stretches could carry solar and storage. People approve, reject or override every action, and every decision is logged.

**AI explains. Rules (or a small, visible learned model) decide. People approve.**

## Problem

Weather-driven ground failures are rare but expensive, and operators often see them too late. In the 2020 Hillsboro, Kentucky rupture, the operator had already found the landslide and planned to fix it that summer; the slope failed first. Meanwhile most corridor land earns nothing beyond the lease.

## What it does

1. **Predict (5 and 10 years).** For each 1 km segment: observed baseline from the Open-Meteo archive (1995 to 2025), three CMIP6 models (MRI, EC-Earth, MPI) for 2026 to 2036, compared with each model's own history (delta method). Counts extreme-rain days, freeze-thaw days and wet-soil days; adds Sentinel-2 NDVI trend and slope. Score 0 to 100, tier, model agreement. Missing data means "unverified", never green.
2. **Price it.** Expected loss per segment, loss avoided by a targeted inspection, risk-based inspection savings, break-even, and net value, with every assumption on a slider.
3. **Build layer.** Solar plus storage potential outside the 30 m CER prescribed area: MW, MWh, lease revenue and the landowner partner's share. Rising risk halves the build score.
4. **Humans in charge.** Approve or reject work orders, override a tier with a required reason. All of it goes to the audit log.

Real check (Nov 14, live APIs, a point in central Alberta): all three climate models agree extreme-rain days rise by 2036 (+7% to +37%, mean +26% vs each model's own history); wet-soil days +60% in the two models that report soil moisture.

## Honest numbers

On the 169 km demo corridor at $430k per failure (sourced average), avoided failures alone do not pay for the program; inspection savings and new lease revenue do the work. At $11.7M per failure (one sourced geohazard rupture) the 10-year net turns positive. The dashboard shows both; we do not hide the slider.

## Repo layout

```
src/engine.js            The whole engine: segmenting, baselines, projections, NDVI trend, risk, build, money. Pure JS.
test/engine.test.js      16 unit tests: npm test
scripts/make-demo.js     Synthetic demo corridor run through the real engine -> data/demo/corridor.json
scripts/build.js         Inlines the engine into dist/dashboard*.html and dist/n8n/*.js (Code node bodies)
scripts/make-workflow.js Generates workflows/terracorridor.json (import into n8n)
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
