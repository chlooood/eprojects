# Tier mapping and horizons (provisional)

One mapping is used by `src/engine.js`, `src/dashboard-api.js` (the API feed) and the n8n W2 Config node. `npm test` fails if they drift apart.

| Setting | Value | Where |
| --- | --- | --- |
| Full factor score | a +50% rise in a climate count vs 1995-2025 (`ratioFull` / `ratio_full_score_increase` = 0.5) | engine, API, W2 |
| Medium (amber) | score >= 40 | engine, API, W2 |
| High (red) | score >= 65 | engine, API, W2 |
| High, models disagree | red, low model agreement, and the worst hazard is rain-based (ground failure or crossing) | engine, API |

A segment's score is its worst hazard (ground failure, river crossing, wildfire weather, drought), never a blend. The score is a 0-100 priority index. It is not a failure probability.

## What was wrong (found on the live tables, Nov 15 2026)

Live W2 Config had `ratio_full_score_increase = 0.15` and `red_above = 50`, while the engine used +100% and 65 and the API feed said 50. On the live corridor every one of the 23 segments was green at 5 years and red at 10 years.

Cause, from the stored rows: the 23 segments sit in 4 climate cells (10 km grid), so they share their climate inputs. At 10 years the three-model mean was about +15% extreme-rain days, +2 to +4% freeze-thaw days and +40 to +66% wet-soil days. With full score at +15%, the rain factor (weight 0.35) and wet-soil factor (0.15) were both maxed, so climate alone gave 52 to 55 points. Red started above 50. Every kilometre crossed the line together, whatever its slope or vegetation. At 5 years the same models showed extreme rain at -6%, so the rain factor was 0 and everything was green.

## Why +50%, and why not lower

Extreme-rain days are rare: about 4.6 a year at these cells (days above the 95th percentile of wet-day rain). A 10-year window holds about 46 such days and a 5-year window about 23. Counting noise alone (Poisson) is about ±15% for 10 years and ±21% for 5 years. The three models' own 10-year ratios for one cell were 1.23, 1.32 and 0.90. A scale that saturates at +15% turns one standard deviation of noise into a maximum score. +50% is about three standard deviations of the 10-year count and is the value W2 was first designed with.

This is a reasoned default, not a calibration. There is no failure data behind it. It is one number, the same for every factor, even though freeze-thaw and wet-soil days are far more frequent and less noisy. Treat it as provisional and for expert review. Do not tune it to make a map look busier or calmer.

## Result on the live corridor with this mapping

Ground-failure scores are 23 to 38 at 10 years (Low). Segments that cross a mapped stream score 35 to 41 on the crossing hazard; one reaches Medium. No segment is High. That is the honest reading of this corridor: flat ground near Edmonton with a modest climate signal. The tool still ranks the kilometres, and the top of the ranking is explained by something physical (a stream crossing, vegetation loss).

## The two projection windows

The two views are separate five-year windows: "2026-30" is the model average for 2026-2030 and "2031-35" is the average for 2031-2035. They do not overlap (until 2026-11-15 the second window was 2026-2035 and contained the first; cache signature v3 marks the change, and older v1/v2 cells are refetched rather than reused).

Why averages and not a single year: a climate model does not forecast the weather of a particular year. Any one model year is simulated weather, so we average five years and compare with each model's own 1995-2025 history. Five years of a noisy count is still noisy: a hazard can rise in the first window and fall in the second. We do not force them to agree. Both are climate-frequency projections for planning, not forecasts.

## What a tier triggers

Nothing automatic. A long-range tier is a planning signal. Work orders come from two places only: the integrity manager approving a segment on the dashboard, or WF3 finding heavy weather in the 16-day forecast on ground that is already Medium or High. WF3 ships with `DRY_RUN = true` and a cap of 3 drafts per run (`MAX_DRAFTS_PER_RUN`), and logs every proposed or suppressed draft to `corridor_audit`.
