#!/usr/bin/env node
// Saves the offline snapshot the dashboard falls back to when n8n cannot be reached: data/snapshot/live-snapshot.json.
// scripts/build.js inlines it into dist/dashboard.html and deploy/index.html as window.TC_SNAPSHOT.
//
//   node scripts/make-snapshot.js https://YOUR-INSTANCE.app.n8n.cloud/webhook/terracorridor
//
// If the live feed already carries all the hazard scores (W2 has run with the multi-hazard code), it is saved as is.
// If it does not, pass --recompute: the hazard scores are then recomputed HERE with the real "Score Segments" code
// from the W2 export, fed with the live feed's own slope and NDVI values, the cached climate cells
// (data/cache/cells) and the mapped crossings (data/cache/crossings). The snapshot says so in meta.snapshot.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { buildCorridor } = require('../src/dashboard-api.js');
const src = process.argv[2], recompute = process.argv.includes('--recompute');
if (!src) { console.error('Give the API base URL or a saved feed JSON file.'); process.exit(1); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function main() {
  const feed = /^https?:/.test(src) ? await (await fetch(src.replace(/\/$/, '') + '/corridor')).json() : JSON.parse(fs.readFileSync(src, 'utf8'));
  if (!feed || !Array.isArray(feed.segments) || !feed.segments.length) throw new Error('feed has no segments');
  const scored = (feed.meta && feed.meta.hazardsScored) || [];
  const now = new Date().toISOString();
  let out = feed;
  if (!recompute) {
    if (scored.length < 2) console.warn('WARNING: this feed only has ground-failure scores (W2 has not run with the multi-hazard code). Use --recompute, or re-run W2 first.');
    out.meta.snapshot = { savedAt: now, recomputed: false, note: 'Saved copy of the live n8n feed.' };
  } else {
    const W2 = JSON.parse(fs.readFileSync(path.join(root, 'workflows', 'W2_ Long-Range Engine.json'), 'utf8'));
    const node = (n) => W2.nodes.find((x) => x.name === n);
    const cfg = Object.fromEntries(node('W2 Config').parameters.assignments.assignments.filter((a) => typeof a.value !== 'string' || !a.value.startsWith('=')).map((a) => [a.name, a.value]));
    cfg.corridor_id = feed.meta.corridorId;
    const cells = JSON.parse(fs.readFileSync(path.join(root, 'data', 'cache', 'cells', 'trans-northern-cells.json'), 'utf8'));
    const xFile = path.join(root, 'data', 'cache', 'crossings', feed.meta.corridorId + '-crossings.json');
    const crossings = fs.existsSync(xFile) ? JSON.parse(fs.readFileSync(xFile, 'utf8')).segments : {};
    const CELL = Number(cfg.grid_cell_deg) || 0.1;
    const segs = feed.segments.map((s) => {
      const a = s.centreline[0], b = s.centreline[s.centreline.length - 1];
      const cLat = (a[1] + b[1]) / 2, cLon = (a[0] + b[0]) / 2;
      return { segment_id: s.id, corridor_id: feed.meta.corridorId, segment_index: s.index, length_m: s.lengthM,
        cell_key: (Math.round(cLat / CELL) * CELL).toFixed(2) + '_' + (Math.round(cLon / CELL) * CELL).toFixed(2),
        centroid_lat: cLat, centroid_lon: cLon, valid: true, validation_errors: [], elevation_url: 'snapshot', segment_source_hash: '',
        crossings_json: Array.isArray(crossings[s.id]) ? JSON.stringify(crossings[s.id]) : null,
        // NDVI: the series the live W2 run stored (Sentinel-2 via Copernicus), reused through W2's own cache path.
        prior_ndvi_series_json: JSON.stringify((s.ndviSeries || []).map((p) => ({ month: p.date.slice(0, 7), mean: p.ndvi }))), prior_ndvi_hash: 'from-live-feed', prior_ndvi_source: 'cdse_live' };
    });
    const elev = feed.segments.map((s) => { const data = JSON.stringify({ elevation: [0, (s.slopePct || 0) * s.lengthM / 100] }); return { data, raw_hash: sha(data) }; });
    const recs = cells.map((c) => ({ cell_key: c.cell_key, cache_status: 'cached', archive: JSON.parse(c.archive_metrics_json), climate: JSON.parse(c.climate_metrics_json) }));
    const wrap = (arr) => arr.map((j) => ({ json: j }));
    const mocks = { 'W2 Config': [cfg], 'Select Batch Segments': segs, 'Hash NDVI': segs.map(() => ({ error: { message: 'not refetched for the snapshot' } })), 'Hash Elevation': elev };
    const $ = (name) => { const items = wrap(mocks[name]); return { all: () => items, first: () => items[0] }; };
    const rows = (await new AsyncFunction('$', '$input', node('Score Segments').parameters.jsCode)($, { all: () => wrap(recs) })).map((o) => o.json);
    const bad = rows.filter((r) => r.status !== 'verified');
    if (bad.length) console.warn(`WARNING: ${bad.length} prediction rows are unverified, e.g. ${bad[0].segment_id}: ${bad[0].error_message}`);
    const mini = buildCorridor({
      segments: feed.segments.map((s) => ({ segment_id: s.id, corridor_id: feed.meta.corridorId, segment_index: s.index, length_m: s.lengthM,
        lon_start: s.centreline[0][0], lat_start: s.centreline[0][1], lon_end: s.centreline[s.centreline.length - 1][0], lat_end: s.centreline[s.centreline.length - 1][1], source_kind: s.sourceKind })),
      baselines: rows.filter((r) => r.baseline_row).map((r) => r.baseline_row), predictions: rows, build: [], buildConfig: [], watch: [], workOrders: [],
    }, { now, corridorId: feed.meta.corridorId });
    const byId = Object.fromEntries(mini.segments.map((s) => [s.id, s]));
    for (const s of out.segments) {
      const m = byId[s.id];
      Object.assign(s, { risk: m.risk, crossings: m.crossings, crossingsChecked: m.crossingsChecked, projections: m.projections, explanation: '', workOrder: null, override: null, nearTerm: null });
      Object.assign(s.baseline, { drySoilDaysPerYr: m.baseline.drySoilDaysPerYr, drySpellDays: m.baseline.drySpellDays, fireWeatherDaysPerYr: m.baseline.fireWeatherDaysPerYr });
    }
    Object.assign(out.config, { tiers: mini.config.tiers, ratioFull: mini.config.ratioFull, horizons: mini.config.horizons });
    Object.assign(out.meta, { generatedAt: now, servedAt: now, hazardsScored: mini.meta.hazardsScored, crossingsChecked: mini.meta.crossingsChecked, segmentsVerified: mini.meta.segmentsVerified,
      snapshot: { savedAt: now, recomputed: true, note: 'Route, slope and NDVI are from the live n8n tables. The hazard scores were recomputed on a laptop with the Score Segments code from the W2 export, the cached Open-Meteo climate cells and the mapped OSM crossings, because the live W2 run predates the multi-hazard scoring.' } });
    out.meta.note = (out.meta.note || '') + ' ' + out.meta.snapshot.note;
  }
  const file = path.join(root, 'data', 'snapshot', 'live-snapshot.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out) + '\n');
  const t = {}; for (const s of out.segments) t[s.risk.y10.tier] = (t[s.risk.y10.tier] || 0) + 1;
  console.log(`${path.relative(root, file)}: ${out.segments.length} segments, hazards ${(out.meta.hazardsScored || []).join(', ')}, 10-year tiers ${JSON.stringify(t)}${recompute ? ' (recomputed)' : ''}`);
}
main().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
