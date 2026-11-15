const test = require('node:test');
const assert = require('node:assert');
const { buildCorridor, ringAreaM2 } = require('../src/dashboard-api.js');
const ENGINE = require('../src/engine.js');

// Rows shaped exactly like the Data Table columns W1, W2 and W5 write (see the Upsert nodes in workflows/).
// inner and outer offsets in degrees of latitude: 0.00027 = 30 m, 0.00207 = 230 m (W1: 30 m exclusion band, 200 m study strip)
const ring = (lon0, lat0, lon1, lat1, inner, outer) => [[lon0, lat0 + inner], [lon1, lat1 + inner], [lon1, lat1 + outer], [lon0, lat0 + outer], [lon0, lat0 + inner]];
function seg(i, source_kind) {
  const lon0 = -113.4 + i * 0.0151, lat0 = 53.5, lon1 = lon0 + 0.0151, lat1 = 53.5; // 0.0151 deg lon at 53.5N is 1000 m
  const geometry = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { zone: 'centreline' }, geometry: { type: 'LineString', coordinates: [[lon0, lat0], [lon1, lat1]] } },
    { type: 'Feature', properties: { zone: 'cer_exclusion_band' }, geometry: { type: 'Polygon', coordinates: [ring(lon0, lat0, lon1, lat1, -0.00027, 0.00027)] } },
    { type: 'Feature', properties: { zone: 'study_strip' }, geometry: { type: 'MultiPolygon', coordinates: [[ring(lon0, lat0, lon1, lat1, 0.00027, 0.00207)], [ring(lon0, lat0, lon1, lat1, -0.00027, -0.00207)]] } },
  ] };
  return { segment_id: 'seg_' + i, corridor_id: 'c1', segment_index: i, lat_start: lat0, lon_start: lon0, lat_end: lat1, lon_end: lon1, length_m: 1000, polygon_geometry_json: JSON.stringify(geometry), status: 'verified', source_kind };
}
const model = (r, f, s) => ({ score: 50, tier: 'amber', rain_ratio: r, freeze_thaw_ratio: f, saturation_ratio: s, soil_from_ensemble: false });
function pred(i, years, score, tier, agreement, status = 'verified') {
  return { prediction_id: 'seg_' + i + '_h' + years, segment_id: 'seg_' + i, corridor_id: 'c1', segment_index: i, horizon_years: years,
    risk_score: status === 'verified' ? score : null, tier: status === 'verified' ? tier : 'unverified', model_agreement: agreement,
    score_r: 0.8, score_f: 0.2, score_w: 0.4, score_v: 0.1, score_s: 0.3, rain_ratio: 1.4, freeze_thaw_ratio: 1.1, saturation_ratio: 1.2,
    model_scores_json: JSON.stringify({ MRI_AGCM3_2_S: model(1.5, 1.1, 1.3), EC_Earth3P_HR: model(1.3, 1.1, 1.1), MPI_ESM1_2_XR: model(1.4, 1.1, 1.2) }),
    explanation: tier === 'red' ? 'Rain days up 40 percent.' : '', status, error_message: status === 'verified' ? '' : 'NDVI: no data', computed_at: '2026-11-14T20:00:00.000Z' };
}
const base = (i) => ({ segment_id: 'seg_' + i, corridor_id: 'c1', cell_key: '53.50_-113.40', centroid_lat: 53.5, centroid_lon: -113.39, baseline_period: '1995-2025',
  rain_p95_mm: 17.4, extreme_rain_days_per_yr: 3.7, freeze_thaw_days_per_yr: 57.8, soil_p90_m3m3: 0.304, saturation_days_per_yr: 36.3,
  ndvi_series_json: JSON.stringify([{ month: '2024-06', mean: 0.66 }, { month: '2024-07', mean: 0.7 }]), ndvi_source: 'cdse_live', ndvi_slope_per_yr: -0.002, ndvi_drop_5yr: 0.013,
  slope_pct: 2.7 + i, status: 'verified' });

const tables = () => ({
  segments: [seg(1, 'fallback_fixture'), seg(0, 'fallback_fixture'), seg(2, 'fallback_fixture')],
  baselines: [base(0), base(1), base(2)],
  predictions: [pred(0, 5, 10, 'green', 'high'), pred(0, 10, 20, 'green', 'high'), pred(1, 5, 70, 'red', 'low'), pred(1, 10, 80, 'red', 'low'),
    pred(2, 5, null, 'x', '', 'unverified'), pred(2, 10, null, 'x', '', 'unverified')],
  build: [{ segment_id: 'seg_0', irradiance: 3.5, substation_km: 7.5 }, { segment_id: 'seg_1', irradiance: 3.5, substation_km: 7.5 }],
  buildConfig: [{ corridor_id: 'c1', config_json: JSON.stringify({ leaseRatePerAcreYr: 700, partnerShare: 0.4, maxBuildSlopePct: 8, unknownKey: 1 }) }],
  watch: [{ segment_id: 'seg_1', override_tier: 'amber', override_reason: 'field check', override_horizon: 'y5', near_term_state: 'escalated', near_term_summary: 'heavy rain' }, {}],
  workOrders: [{ work_order_id: 'WO-1', segment_id: 'seg_1', status: 'pending_approval', priority: 'high', tier: 'red', drafted_at: '2026-11-14T01:00:00Z' }],
});

test('orders segments, accumulates km, derives study area like the repo engine (98.8 acres per km)', () => {
  const d = buildCorridor(tables(), { now: 'T' });
  assert.deepEqual(d.segments.map((s) => s.id), ['seg_0', 'seg_1', 'seg_2']);
  assert.equal(d.segments[1].kmFrom, 1);
  assert.equal(d.segments[2].kmTo, 3);
  assert.ok(Math.abs(d.segments[0].studyAreaAcres - 98.8) < 1.5, 'got ' + d.segments[0].studyAreaAcres);
  assert.equal(d.meta.synthetic, true);
  assert.equal(d.meta.segmentsVerified, 2);
});

test('risk, projections, override and work order map through', () => {
  const s = buildCorridor(tables()).segments;
  assert.equal(s[0].risk.y10.score, 20);
  assert.equal(s[1].risk.y10.tier, 'red-uncertain'); // red with low agreement
  assert.equal(s[1].risk.y10.drivers[0].key, 'rain');
  assert.equal(s[1].explanation, 'Rain days up 40 percent.');
  assert.equal(s[1].override.tier, 'amber');
  assert.equal(s[1].override.horizon, 5);
  assert.equal(s[1].workOrder.status, 'pending_approval');
  assert.equal(s[0].projections.y10.MRI_AGCM3_2_S.extremeDaysPerYr, 5.55);
  assert.equal(s[0].ndvi.change5yr, -0.013);
  assert.equal(s[0].ndviSeries[0].date, '2024-06-15');
});

test('fail closed: unverified segment is never green, empty tables do not crash', () => {
  const s = buildCorridor(tables()).segments[2];
  assert.equal(s.risk.y10.tier, 'unverified');
  assert.equal(s.risk.y10.score, null);
  const empty = buildCorridor({ segments: [], baselines: [{}], predictions: [], build: [], buildConfig: [], watch: [], workOrders: [] });
  assert.equal(empty.segments.length, 0);
  const noPreds = buildCorridor({ ...tables(), predictions: [], baselines: [] }).segments;
  assert.ok(noPreds.every((x) => x.risk.y5.tier === 'unverified' && x.risk.y10.tier === 'unverified'));
});

test('saved W5 assumptions reach the dashboard config, unknown keys are ignored', () => {
  const c = buildCorridor(tables()).config;
  assert.equal(c.money.leaseRatePerAcreYr, 700);
  assert.equal(c.money.partnerShare, 0.4);
  assert.equal(c.buildMaxSlopePct, 8);
  assert.equal(c.unknownKey, undefined);
});

test('the dashboard engine consumes the feed end to end', () => {
  const d = buildCorridor(tables());
  const cfg = ENGINE.mergeConfig(d.config);
  for (const s of d.segments) s.build = ENGINE.buildScore(s, s.risk.y10, cfg);
  const sum = ENGINE.corridorSummary(d.segments, cfg, { years: 10, topN: 10 });
  assert.equal(sum.segments, 3);
  assert.equal(sum.tiers.unverified, 1);
  assert.equal(d.segments[2].build.tier, 'unverified');
  assert.ok(d.segments[0].build.usableAcres > 90);
  JSON.stringify(d); // serialisable
});

test('ring area sanity', () => {
  assert.equal(ringAreaM2([[0, 0], [1, 1]]), 0);
});
