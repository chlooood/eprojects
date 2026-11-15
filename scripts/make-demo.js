// Builds data/demo/corridor.json: a SYNTHETIC corridor run through the real engine,
// so the dashboard can be built and tested before n8n produces live data.
// The route is illustrative (not a real pipeline). Climate series are simulated.
// Irradiance is a real NASA POWER annual value fetched once if the network allows.
// Usage: node scripts/make-demo.js
const fs = require('fs');
const path = require('path');
const E = require('../src/engine.js');

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
// A second stream for humidity and crossings, so adding them leaves the rain story unchanged.
let seed2 = 7;
const rnd2 = () => ((seed2 = (seed2 * 1664525 + 1013904223) % 4294967296) / 4294967296);
const gauss2 = () => Math.sqrt(-2 * Math.log(rnd2() + 1e-12)) * Math.cos(2 * Math.PI * rnd2());

// Illustrative route: Edmonton area east-southeast toward Hardisty, Alberta.
function makeRoute() {
  const a = [-113.38, 53.52], b = [-111.32, 52.70], pts = [];
  const n = 60;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const wiggle = 0.03 * Math.sin(t * 9) + 0.015 * Math.sin(t * 23);
    pts.push([a[0] + (b[0] - a[0]) * t + wiggle * 0.6, a[1] + (b[1] - a[1]) * t + wiggle]);
  }
  return pts;
}

function simulateDaily(years, p) {
  // p.histYears: years up to this one use the historical climate (model's own past run)
  const time = [], pr = [], tmin = [], tmax = [], soil = [], rh = [];
  let s = 0.28;
  for (const y of years) for (let d = 0; d < 365; d++) {
    time.push(new Date(Date.UTC(y, 0, 1 + d)).toISOString().slice(0, 10));
    const season = Math.sin(((d - 105) / 365) * 2 * Math.PI); // peak mid-July
    const past = p.histYears && y <= p.histYears;
    const rs = past ? 1 + (p.bias || 0) : p.rainScale, sp = past ? 0.012 : p.stormProb, wm = past ? 0 : p.warming;
    const dry = past ? 0 : (p.dryness || 0);              // drying future in the drought stretches
    const wetProb = (0.22 + 0.12 * Math.max(0, season)) * (1 - 0.3 * dry * Math.max(0, season));
    let rain = 0;
    if (rnd() < wetProb) rain = -Math.log(rnd() + 1e-9) * (3 + 3 * Math.max(0, season)) * rs;
    if (rnd() < sp * Math.max(0, season)) rain += 20 + 25 * rnd();
    const tmean = 3 + wm + 15.5 * season + 3 * gauss();
    const range = 6 + 3 * rnd();
    s = Math.min(0.5, Math.max(0.08, s * 0.97 + rain * 0.004 + 0.003 - 0.004 * Math.max(0, season)));
    time.length; pr.push(Math.round(rain * 10) / 10);
    tmin.push(Math.round((tmean - range / 2) * 10) / 10);
    tmax.push(Math.round((tmean + range / 2) * 10) / 10);
    soil.push(Math.round(s * 1000) / 1000);
    const tx = tmean + range / 2;
    const h = 72 - 28 * Math.max(0, season) - 1.2 * (tx - wm - 18) + 9 * gauss2() + (rain > 0 ? 25 : 0) - 9 * dry;
    rh.push(Math.round(Math.min(100, Math.max(8, h))));
  }
  const out = { time, precipitation_sum: pr, temperature_2m_min: tmin, temperature_2m_max: tmax, soil_moisture_0_to_10cm_mean: soil };
  if (p.rh !== false) out.relative_humidity_2m_min = rh;   // MPI has no humidity in the real API either
  return out;
}

async function nasaIrradiance(lat, lon) {
  try {
    const url = `https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=ALLSKY_SFC_SW_DWN&community=RE&longitude=${lon}&latitude=${lat}&format=JSON`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    return { value: j.properties.parameter.ALLSKY_SFC_SW_DWN.ANN, source: url };
  } catch (e) {
    return { value: 3.5, source: 'fallback 3.5 kWh/m2/day (NASA POWER unreachable)' };
  }
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

(async () => {
  const cfg = E.DEFAULTS;
  const route = makeRoute();
  const segs = E.segmentRoute(route, cfg);
  const mid = segs[Math.floor(segs.length / 2)].mid;
  const irr = await nasaIrradiance(mid[1], mid[0]);

  const models = ['MRI_AGCM3_2_S', 'EC_Earth3P_HR', 'MPI_ESM1_2_XR'];
  const cellKm = 10;
  const cells = {};
  const nCells = Math.ceil(segs.length / cellKm);
  for (let c = 0; c < nCells; c++) {
    const pos = c / Math.max(1, nCells - 1);
    // Wetter future in the middle third and near the east end (a story for the demo)
    const hot = Math.exp(-((pos - 0.38) ** 2) / 0.012) + 0.7 * Math.exp(-((pos - 0.8) ** 2) / 0.008);
    // Drying and fire story: the west end and a stretch past the middle get drier summers.
    const dryness = Math.exp(-((pos - 0.06) ** 2) / 0.006) + 0.8 * Math.exp(-((pos - 0.6) ** 2) / 0.004);
    const base = simulateDaily(range(1995, 2025), { rainScale: 1, stormProb: 0.012, warming: 0 });
    const proj = {};
    models.forEach((m, k) => {
      const modelBias = [0.0, 0.06, -0.04][k];
      proj[m] = simulateDaily(range(1995, 2036), {
        histYears: 2025,
        rainScale: 1.02 + 0.22 * hot + modelBias,
        stormProb: 0.012 * (1 + 1.6 * hot + modelBias * 3),
        warming: 0.9 + 0.3 * k + 0.6 * dryness,
        bias: [0.05, -0.08, 0.1][k],
        dryness,
        rh: m !== 'MPI_ESM1_2_XR',
      });
    });
    cells[c] = { base, proj };
  }

  const substations = [route[3], route[24], route[41], route[58]];
  // Illustrative waterways (not real rivers): short lines across the route, found with ENGINE.findCrossings.
  const WATER = [
    { km: 18, name: 'West river (illustrative)', kind: 'river', peakFlowM3s: 320 },
    { km: 62, name: 'Creek (illustrative)', kind: 'stream', peakFlowM3s: 14 },
    { km: 71, name: 'Central river (illustrative)', kind: 'river', peakFlowM3s: 180 },
    { km: 118, name: 'Irrigation canal (illustrative)', kind: 'canal', peakFlowM3s: 25 },
    { km: 140, name: 'Brook (illustrative)', kind: 'stream', peakFlowM3s: 9 },
  ];
  const waterways = WATER.map((w) => {
    const sg = segs[w.km], a = sg.centreline[0], b = sg.centreline[sg.centreline.length - 1];
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d = [b[0] - a[0], b[1] - a[1]], n = Math.hypot(d[0], d[1]);
    const perp = [-d[1] / n, d[0] / n], L = 0.03 + 0.01 * rnd2(), bend = 0.004 * gauss2();
    return { name: w.name, kind: w.kind, peakFlowM3s: w.peakFlowM3s,
      coords: [[m[0] - perp[0] * L, m[1] - perp[1] * L], [m[0] + bend, m[1] - bend], [m[0] + perp[0] * L, m[1] + perp[1] * L]] };
  });
  const found = E.findCrossings(segs, waterways);
  for (const [id, xs] of Object.entries(found)) {
    const sg = segs.find((x) => x.id === id);
    sg.crossings = xs.map((x) => ({ ...x, peakFlowM3s: waterways.find((w) => w.name === x.name).peakFlowM3s }));
  }
  const valleys = [0.3, 0.42, 0.79];

  for (const [i, s] of segs.entries()) {
    const cell = cells[Math.floor(i / cellKm)];
    s.cell = `C${Math.floor(i / cellKm)}`;
    s.baseline = E.baselineStats(cell.base, cfg);
    s.projections = {
      y5: E.projectedStats(cell.proj, s.baseline, cfg.horizons.y5, cfg),
      y10: E.projectedStats(cell.proj, s.baseline, cfg.horizons.y10, cfg),
    };
    const pos = i / segs.length;
    const v = valleys.reduce((m, c) => Math.max(m, Math.exp(-((pos - c) ** 2) / 0.0004)), 0);
    s.slopePct = Math.round((1 + 2 * rnd() + 16 * v) * 10) / 10;
    // NDVI: thinning cover on some valley slopes and a disturbed stretch
    const decline = 0.004 + 0.028 * v + (pos > 0.6 && pos < 0.66 ? 0.02 : 0);
    const series = [];
    for (const y of range(2019, 2025)) for (const mo of [5, 6, 7, 8, 9]) {
      const seasonal = 0.62 + 0.12 * Math.sin(((mo - 5) / 4) * Math.PI);
      series.push({ date: `${y}-0${mo}-15`, ndvi: Math.round((seasonal - decline * (y - 2019) + 0.02 * gauss()) * 1000) / 1000 });
    }
    s.ndviSeries = series;
    s.ndvi = E.ndviTrend(series);
    s.irradiance = Math.round((irr.value + 0.05 * gauss()) * 100) / 100;
    s.substationKm = Math.round(Math.min(...substations.map((p) => E.haversine(s.mid, p))) / 100) / 10;
    s.risk = { y5: E.riskScore(s, 'y5', cfg), y10: E.riskScore(s, 'y10', cfg) };
    s.build = E.buildScore(s, s.risk.y10, cfg);
    s.money = { y5: E.moneyForSegment(s.risk.y5, 5, cfg), y10: E.moneyForSegment(s.risk.y10, 10, cfg) };
  }

  const out = {
    meta: {
      name: 'Demo corridor (illustrative)',
      synthetic: true,
      note: 'SYNTHETIC demo data run through the real engine. Route is illustrative, not a real pipeline. Climate series are simulated. Replace with the first n8n run.',
      generatedAt: new Date().toISOString(),
      irradianceSource: irr.source,
      models,
    },
    config: cfg,
    route,
    substations,
    waterways: waterways.map(({ name, kind, coords }) => ({ name, kind, coords })),
    segments: segs,
    summary: { y5: E.corridorSummary(segs, cfg, { years: 5 }), y10: E.corridorSummary(segs, cfg, { years: 10 }) },
  };
  const file = path.join(__dirname, '..', 'data', 'demo', 'corridor.json');
  fs.writeFileSync(file, JSON.stringify(out));
  const s10 = out.summary.y10;
  console.log(`segments ${segs.length}, km ${s10.km}, tiers ${JSON.stringify(s10.tiers)}`);
  console.log(`top share of loss ${s10.topShareOfLoss}, loss avoided ${s10.lossAvoided}, wo cost ${s10.workOrderCost}, inspection savings/yr ${s10.inspectionSavingsYr}, lease/yr ${s10.leaseRevenueYr}`);
  console.log('top 3', s10.top.slice(0, 3).map((t) => `${t.id} ${t.score} ${t.tier} ${t.hazard} ${t.why}`));
  console.log('red km by hazard', JSON.stringify(s10.hazardKm), 'crossing km', s10.crossings);
  console.log('irradiance', irr.value, 'size KB', Math.round(fs.statSync(file).size / 1024));
})();
