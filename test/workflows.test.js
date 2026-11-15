// Runs the real Code-node source from workflows/*.json against W2-shaped rows with n8n's globals mocked.
// This is what proves the workflows agree on the data, short of running them in n8n.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'workflows');
const wf = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const WF3 = wf('TerraCorridor WF3 - Near-term watch.json');
const WF4 = wf('TerraCorridor WF4 - Work orders and approvals.json');
const W5 = wf('TerraCorridor W5 - Solar + Storage Build Layer and Weekly Report.json');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function run(workflow, nodeName, { nodes = {}, input = [] } = {}) {
  const js = workflow.nodes.find((n) => n.name === nodeName).parameters.jsCode;
  const wrap = (arr) => arr.map((j) => ({ json: j }));
  const $ = (name) => {
    if (!(name in nodes)) throw new Error('mock has no node ' + name);
    const items = wrap(nodes[name]);
    return { all: () => items, first: () => items[0], last: () => items[items.length - 1], item: items[0] };
  };
  const $input = { all: () => wrap(input), first: () => wrap(input)[0] };
  return new AsyncFunction('$', '$input', '$now', 'DateTime', js)($, $input, new Date(), null);
}

// ---- W2-shaped fixture (column names from the W2 Upsert nodes)
const mdl = (r, f, s) => ({ score: 50, tier: 'amber', rain_ratio: r, freeze_thaw_ratio: f, saturation_ratio: s });
const pred = (id, years, score, tier, agreement, status = 'verified') => ({
  prediction_id: id + '_h' + years, segment_id: id, corridor_id: 'c1', horizon_years: years, risk_score: status === 'verified' ? score : null,
  tier: status === 'verified' ? tier : 'unverified', model_agreement: agreement, score_r: 0.9, score_f: 0.2, score_w: 0.4, score_v: 0.1, score_s: 0.3,
  rain_ratio: 1.45, freeze_thaw_ratio: 1.1, saturation_ratio: 1.2, model_scores_json: JSON.stringify({ A: mdl(1.5, 1.1, 1.3) }),
  explanation: '', status, error_message: '', computed_at: '2026-11-14T20:00:00Z',
});
const base = (id, cell, slope) => ({ segment_id: id, corridor_id: 'c1', cell_key: cell, centroid_lat: 53.5, centroid_lon: -113.4, baseline_period: '1995-2025',
  rain_p95_mm: 17.4, extreme_rain_days_per_yr: 3.7, freeze_thaw_days_per_yr: 57.8, soil_p90_m3m3: 0.304, saturation_days_per_yr: 36.3, ndvi_slope_per_yr: -0.002, ndvi_drop_5yr: 0.013, slope_pct: slope, status: 'verified' });
const predictions = [pred('seg_g', 5, 10, 'green', 'high'), pred('seg_g', 10, 20, 'green', 'high'),
  pred('seg_a', 5, 45, 'amber', 'high'), pred('seg_a', 10, 55, 'amber', 'medium'),
  pred('seg_r', 5, 70, 'red', 'high'), pred('seg_r', 10, 80, 'red', 'low'),
  pred('seg_u', 5, null, 'x', '', 'unverified'), pred('seg_u', 10, null, 'x', '', 'unverified')];
const baselines = [base('seg_g', '53.50_-113.40', 1), base('seg_a', '53.50_-113.40', 4), base('seg_r', '53.60_-113.30', 6), base('seg_u', '53.60_-113.30', 2)];

test('WF3 reads W2 tables: flags amber and red, skips green and unverified, groups by cell', async () => {
  const out = await run(WF3, 'Select flagged segments', { nodes: { 'Get predictions': predictions, 'Get watch state': [{}], 'Get baselines': baselines } });
  const cells = out.map((o) => o.json);
  assert.equal(cells.length, 2);
  const all = cells.flatMap((c) => c.segments);
  assert.deepEqual(all.map((s) => s.segment_id).sort(), ['seg_a', 'seg_r']);
  const red = all.find((s) => s.segment_id === 'seg_r');
  assert.equal(red.tier, 'red-uncertain'); // red with low model agreement
  assert.equal(red.horizon, 'y10');
  assert.equal(JSON.parse(red.drivers_json)[0].key, 'rain');
  assert.equal(cells[0].annual.extreme_mm, 17.4);
  assert.equal(cells[0].has_baseline, true);
});

test('WF3 honours a W4 override stored in corridor_watch, per horizon', async () => {
  const watch = [{ segment_id: 'seg_r', override_tier: 'green', override_horizon: 'y10', override_reason: 'checked on site' }, { segment_id: 'seg_g', override_tier: 'red', override_horizon: 'y10' }];
  const out = await run(WF3, 'Select flagged segments', { nodes: { 'Get predictions': predictions, 'Get watch state': watch, 'Get baselines': baselines } });
  const segs = Object.fromEntries(out.flatMap((o) => o.json.segments).map((s) => [s.segment_id, s]));
  assert.deepEqual(Object.keys(segs).sort(), ['seg_a', 'seg_g', 'seg_r']);
  assert.equal(segs.seg_r.horizon, 'y5', 'y10 was overridden down to green, the y5 red still stands');
  assert.equal(segs.seg_r.overridden, false);
  assert.equal(segs.seg_g.tier, 'red'); assert.equal(segs.seg_g.overridden, true); assert.equal(segs.seg_g.horizon, 'y10');
});

const forecast = (heavyDay) => ({ daily: { time: Array.from({ length: 16 }, (_, i) => '2026-11-' + String(15 + i).padStart(2, '0')),
  precipitation_sum: Array.from({ length: 16 }, (_, i) => (i === heavyDay ? 30 : 1)), soil_moisture_0_to_7cm_mean: Array(16).fill(0.2),
  temperature_2m_min: Array(16).fill(1), temperature_2m_max: Array(16).fill(8) } });

async function wf3Flow(forecasts) {
  const selected = await run(WF3, 'Select flagged segments', { nodes: { 'Get predictions': predictions, 'Get watch state': [{}], 'Get baselines': baselines } });
  const cells = selected.map((o) => o.json);
  const applied = await run(WF3, 'Apply escalation rules', { nodes: { 'Select flagged segments': cells }, input: forecasts(cells.length) });
  return applied.map((o) => o.json);
}

test('WF3 heavy rain escalates with high priority; red always routes to WF4 even when quiet or when the forecast failed', async () => {
  const heavy = await wf3Flow((n) => Array.from({ length: n }, () => forecast(3)));
  assert.ok(heavy.every((r) => r.route === 'escalated'));
  assert.ok(heavy.every((r) => r.priority === 'high'));
  const quiet = await wf3Flow((n) => Array.from({ length: n }, () => forecast(-1)));
  assert.equal(quiet.find((r) => r.segment_id === 'seg_r').route, 'escalated', 'red goes to a work order with a quiet forecast');
  assert.equal(quiet.find((r) => r.segment_id === 'seg_a').route, 'none', 'amber with a quiet forecast does nothing');
  const failed = await wf3Flow((n) => Array.from({ length: n }, () => ({ error: { message: '429' } })));
  assert.equal(failed.find((r) => r.segment_id === 'seg_r').route, 'escalated', 'a failed forecast must not hide a red segment');
  assert.equal(failed.find((r) => r.segment_id === 'seg_a').route, 'unverified', 'amber with a failed forecast is logged unverified, not clear');
  assert.equal(failed.find((r) => r.segment_id === 'seg_a').state, 'unverified');
});

test('WF4 turns WF3 output into a fact sheet and a work order for red and for escalated amber only', async () => {
  const items = await wf3Flow((n) => Array.from({ length: n }, () => forecast(3)));
  const out = await run(WF4, 'Build facts', { input: items });
  const wo = out.map((o) => o.json);
  assert.equal(wo.length, 2);
  const red = wo.find((w) => w.segment_id === 'seg_r');
  assert.match(red.work_order_id, /^WO-seg_r-/);
  assert.ok(red.facts.some((f) => /Extreme-rain days/.test(f)), 'driver line present');
  const quiet = await wf3Flow((n) => Array.from({ length: n }, () => forecast(-1)));
  const quietWo = (await run(WF4, 'Build facts', { input: quiet })).map((o) => o.json);
  assert.deepEqual(quietWo.map((w) => w.segment_id), ['seg_r'], 'quiet amber gets no work order');
});

test('WF4 validator accepts the dashboard payloads exactly as web/dashboard.html sends them', async () => {
  const v = async (body) => (await run(WF4, 'Validate action', { input: [{ body }] }))[0].json;
  const ok1 = await v({ at: 'x', segment: 'seg_r', action: 'approve_work_order', details: {}, score: 80, by: 'operator (demo)' });
  assert.equal(ok1.ok, true); assert.equal(ok1.decision, 'approve');
  const ok2 = await v({ at: 'x', segment: 'seg_r', action: 'override_tier', details: { from: 'red', to: 'amber', reason: 'site visit', horizon: 10 }, score: 80, by: 'op' });
  assert.equal(ok2.ok, true); assert.equal(ok2.horizon, 'y10'); assert.equal(ok2.to_tier, 'amber');
  assert.equal((await v({ segment: 'seg_r', action: 'override_tier', details: { to: 'amber', reason: '', horizon: 10 } })).ok, false, 'override without a reason is refused');
  assert.equal((await v({ segment: 'seg_r', action: 'delete_everything' })).ok, false);
  assert.equal((await v({ action: 'approve_work_order' })).ok, false, 'missing segment is refused');
});

test('W5 pivots W2 rows (two per segment) instead of silently scoring everything unverified', async () => {
  const segs = [{ segment_id: 'seg_g', length_m: 1000 }, { segment_id: 'seg_r', length_m: 1000 }, { segment_id: 'seg_u', length_m: 1000 }];
  const out = (await run(W5, 'Adapter: Upstream W2-W4', {
    nodes: { 'Adapter: Segments': [{ segments: segs }], 'Load W2 Predictions': predictions, 'Load W2 Baselines': baselines,
      'Load W3 Alerts': [{ segment_id: 'seg_r', near_term_state: 'escalated', near_term_summary: 'heavy rain', near_term_checked_at: '2026-11-14T06:00:00Z' }],
      'Load W4 Audit': [{ segment_id: 'seg_r', work_order_id: 'WO-1', action: 'work_order', status: 'pending_approval' }] },
  }))[0].json;
  assert.equal(out.modes.predictions, 'live');
  const r = out.predictions.find((p) => p.segment_id === 'seg_r');
  assert.equal(r.risk10_tier, 'red'); assert.equal(r.risk5_tier, 'red'); assert.equal(r.risk10_score, 80); assert.equal(r.slope_pct, 6);
  const u = out.predictions.find((p) => p.segment_id === 'seg_u');
  assert.equal(u.risk10_tier, 'unverified', 'unverified stays unverified');
  assert.equal(out.modes.alerts, 'live');
  assert.equal(out.alerts[0].severity, 'high');
  assert.equal(out.audit[0].approval_status, 'pending_approval');
});

test('W5 usable area matches W1 geometry and the repo engine (98.8 acres per km, not 84)', async () => {
  const calc = W5.nodes.find((n) => n.name === 'Compute Build Layer').parameters.jsCode;
  assert.ok(!/studyStripWidthM - cfg\.exclusionBandM/.test(calc));
  const m = calc.match(/geomAcres = [^;]+;/)[0];
  assert.match(m, /2 \* cfg\.studyStripWidthM \* lenM/);
  assert.ok(Math.abs((2 * 200 * 1000) / 4046.8564224 - 98.84) < 0.01);
});
