# TerraCorridor

**Know which kilometres of a pipeline will change class before the houses go up.**

When enough homes appear near a gas pipeline, the operator is on a regulator's clock: six months to file a plan in Canada, 24 months in the United States. Today operators find out by counting buildings after they exist. Fixing it late can mean replacing pipe that takes months to source.

TerraCorridor reads free public records (building permits, development permits, plans in effect) and tells the operator which kilometres are about to change, when, and what each way of dealing with it costs. An engineer approves. Every decision is kept.

## What it does

- **Forecasts class location changes** per kilometre, with the permits behind each one and the deadline that follows.
- **Compares the ways to comply**: lower pressure, test, replace pipe, or an integrity program. Cost, months, and whether it fits before the deadline.
- **Joins what nobody joins.** Class location, ground hazards, land terms and nearby digging sit on the same kilometre and change each other's answers.
- **Keeps the decision record.** What changed, what was chosen, what the crew found, hash-chained per kilometre. That history cannot be scraped.

## See it

Open `dist/platform.html` in a browser. Pick a year and drag the line across the map to compare older satellite imagery with today's. Click any kilometre in the strip.

## What the real data says

On a public pipeline route near Edmonton, using City of Edmonton open data:

- 1,895 dwelling units permitted within 200 m of the line since 2009.
- One stretch went from empty field to Class 3 between 2019 and 2023. The permits showed it first.
- One more kilometre is next: 6 homes today, 23 approved.

## Run it

```
npm test        # 74 tests
npm run build   # rebuilds the data and the pages
```

A weekly GitHub Action refreshes the permit data. No paid services.

## Honest limits

Costs are placeholders. Land terms are example rows. The class rules follow the US regulation because the Canadian standard is paywalled. No operator is involved. Details: [docs/PLATFORM.md](docs/PLATFORM.md). The original geohazard dashboard: [docs/GEOHAZARD_DASHBOARD.md](docs/GEOHAZARD_DASHBOARD.md).

Built by a UBC student team. Started at the UBC eProjects x n8n buildathon.
