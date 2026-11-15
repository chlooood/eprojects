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

test('WF3: only near-term heavy weather on flagged ground proposes a draft; long-range red alone is a planning signal', async () => {
  const heavy = await wf3Flow((n) => Array.from({ length: n }, () => forecast(3)));
  assert.ok(heavy.every((r) => r.state === 'escalated' && r.priority === 'high'));
  assert.ok(heavy.every((r) => r.route === 'preview' && r.escalate === false && /dry run/.test(r.preview_reason)), 'DRY_RUN ships on: nothing reaches Workflow 4');
  assert.deepEqual(heavy.map((r) => r.draft_rank).sort(), [1, 2]);
  const quiet = await wf3Flow((n) => Array.from({ length: n }, () => forecast(-1)));
  assert.equal(quiet.find((r) => r.segment_id === 'seg_r').route, 'none', 'a red 10-year tier with a quiet forecast drafts nothing');
  assert.equal(quiet.find((r) => r.segment_id === 'seg_a').route, 'none');
  const failed = await wf3Flow((n) => Array.from({ length: n }, () => ({ error: { message: '429' } })));
  assert.ok(failed.every((r) => r.route === 'unverified' && r.state === 'unverified'), 'a failed forecast is logged unverified for red and amber, never clear');
});

test('WF3 draft cap: a corridor that is red end to end proposes at most MAX_DRAFTS_PER_RUN, highest score first, the rest are logged as suppressed', async () => {
  const ids = Array.from({ length: 23 }, (_, i) => 'seg_' + String(i).padStart(2, '0'));
  const preds = ids.flatMap((id, i) => [pred(id, 5, 10, 'green', 'high'), pred(id, 10, 52 + i, 'red', 'low')]);
  const bases = ids.map((id) => base(id, '53.40_-113.40', 1));
  const cells = (await run(WF3, 'Select flagged segments', { nodes: { 'Get predictions': preds, 'Get baselines': bases, 'Get watch state': [] } })).map((o) => o.json);
  const live = WF3.nodes.find((n) => n.name === 'Apply escalation rules').parameters.jsCode;
  assert.match(live, /const DRY_RUN = true;/); assert.match(live, /const MAX_DRAFTS_PER_RUN = 3;/);
  const go = async (js) => (await new AsyncFunction('$', '$input', js)((name) => ({ all: () => cells.map((j) => ({ json: j })) }), { all: () => cells.map(() => ({ json: forecast(3) })) })).map((o) => o.json);
  const dry = await go(live);
  assert.equal(dry.length, 23);
  assert.equal(dry.filter((r) => r.route === 'escalated').length, 0, 'dry run: zero calls to Workflow 4');
  const armed = await go(live.replace('const DRY_RUN = true;', 'const DRY_RUN = false;'));
  const sent = armed.filter((r) => r.route === 'escalated');
  assert.equal(sent.length, 3, 'never 23 work orders');
  assert.deepEqual(sent.map((r) => r.score).sort((x, y) => y - x), [74, 73, 72]);
  assert.equal(armed.filter((r) => r.route === 'preview' && /over the cap/.test(r.preview_reason)).length, 20);
  const quiet = (await new AsyncFunction('$', '$input', live.replace('const DRY_RUN = true;', 'const DRY_RUN = false;'))((name) => ({ all: () => cells.map((j) => ({ json: j })) }), { all: () => cells.map(() => ({ json: forecast(-1) })) })).map((o) => o.json);
  assert.equal(quiet.filter((r) => r.route === 'escalated').length, 0, 'no forecast event, no draft, even with 23 red segments');
});

test('WF4 turns an escalated WF3 item into a fact sheet and a work order', async () => {
  const items = (await wf3Flow((n) => Array.from({ length: n }, () => forecast(3)))).map((r) => ({ ...r, route: 'escalated', escalate: true }));
  const wo = (await run(WF4, 'Build facts', { input: items })).map((o) => o.json);
  assert.equal(wo.length, 2);
  const red = wo.find((w) => w.segment_id === 'seg_r');
  assert.match(red.work_order_id, /^WO-seg_r-/);
  assert.ok(red.facts.some((f) => /Extreme-rain days/.test(f)), 'driver line present');
});

test('WF4 manager-requested inspection: approve with no pending draft records one approved order, and a repeat is suppressed', async () => {
  const body = { at: 'x', segment: 'seg_g', action: 'approve_work_order', score: 38.2, by: 'operator (demo)',
    details: { stop: 'y10', tier: 'green', priority: 'P3', dueBy: '2027-05-14', hazard: 'ground', why: 'Wet-soil days +40%', checks: ['Walk the right-of-way', 'x'.repeat(999)], mapUrl: 'https://www.openstreetmap.org/?mlat=53.4&mlon=-113.4#map=15/53.4/-113.4' } };
  const v = (await run(WF4, 'Validate action', { input: [{ body }] }))[0].json;
  assert.equal(v.ok, true); assert.equal(v.req_priority, 'P3'); assert.equal(v.req_checks[1].length, 240);
  assert.equal((await run(WF4, 'Validate action', { input: [{ body: { ...body, details: { ...body.details, mapUrl: 'https://evil.example/x' } } }] }))[0].json.req_map, '');
  const fresh = (await run(WF4, 'Build manager work order', { nodes: { 'Validate action': [v] }, input: [{}] }))[0].json;
  assert.equal(fresh.duplicate, false); assert.equal(fresh.status, 'approved'); assert.equal(fresh.trigger_source, 'manager');
  assert.match(fresh.work_order_id, /^WO-seg_g-/); assert.equal(fresh.decided_by, 'operator (demo)');
  assert.match(fresh.facts_json, /No external delivery in this MVP/);
  const again = (await run(WF4, 'Build manager work order', { nodes: { 'Validate action': [v] }, input: [{ work_order_id: 'WO-old', status: 'approved', decided_at: new Date().toISOString() }] }))[0].json;
  assert.equal(again.duplicate, true); assert.equal(again.work_order_id, 'WO-old');
  const conn = WF4.connections;
  assert.equal(conn['Pending order found?'].main[1][0].node, 'Manager-requested inspection?');
  assert.equal(conn['Manager-requested inspection?'].main[1][0].node, 'Log decision without pending order', 'a reject with nothing pending is still refused and logged');
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

// ---------------------------------------------------------------------------------------------------
// W2 multi-hazard scoring: the real "Score Segments" and helper code from the export, with mocked inputs.
const W2 = wf('W2_ Long-Range Engine.json');
const w2cfg = Object.fromEntries(W2.nodes.find((n) => n.name === 'W2 Config').parameters.assignments.assignments
  .filter((a) => typeof a.value !== 'string' || !a.value.startsWith('=')).map((a) => [a.name, a.value]));
w2cfg.corridor_id = 'c1';
const sha = 'a'.repeat(64);
const ndviJson = (mean) => JSON.stringify({ data: [2021, 2022, 2023, 2024, 2025].flatMap((y) => [6, 7, 8].map((m) => ({ interval: { from: `${y}-0${m}-01T00:00:00Z` }, outputs: { ndvi: { bands: { B0: { stats: { mean, sampleCount: 100, noDataCount: 0 } } } } } }))) });
const w2seg = (id, crossings_json) => ({ segment_id: id, corridor_id: 'c1', segment_index: 0, length_m: 1000, cell_key: 'cellA', valid: true, validation_errors: [],
  centroid_lat: 53.4, centroid_lon: -113.4, elevation_url: 'u', segment_source_hash: 'h', crossings_json });
const ratios = (o) => ({ ok: true, ratios: { 5: { rain: 1, ft: 1, sat: 1, dry: 1, spell: 1, fire: 1, ...o }, 10: { rain: 1, ft: 1, sat: 1, dry: 1, spell: 1, fire: 1, ...o } } });
const cellRec = (models, base = {}) => ({ cell_key: 'cellA', cache_status: 'cached',
  archive: { ok: true, hash: sha, rainP95: 16, soilP90: 0.37, soilP10: 0.2, base: { rain: 4.6, ft: 91, sat: 36, dry: 36, spell: 20, fire: 5, ...base } },
  climate: { ok: true, hash: sha, models } });
async function scoreW2(segs, cell, cfgOver = {}) {
  const out = await run(W2, 'Score Segments', { nodes: {
    'W2 Config': [{ ...w2cfg, ...cfgOver }], 'Select Batch Segments': segs,
    'Hash NDVI': segs.map(() => ({ data: ndviJson(0.6), raw_hash: sha })), 'Hash Elevation': segs.map(() => ({ data: JSON.stringify({ elevation: [700, 700] }), raw_hash: sha })),
  }, input: [cell] });
  return out.map((o) => o.json);
}

test('W2 config and helpers use the one tier mapping: +50% is full, amber 40, red 65 inclusive', () => {
  assert.equal(w2cfg.ratio_full_score_increase, 0.5);
  assert.equal(w2cfg.amber_min, 40); assert.equal(w2cfg.red_above, 65);
  const E = require('../src/engine.js'), api = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard-api.js'), 'utf8');
  assert.equal(E.DEFAULTS.ratioFull, w2cfg.ratio_full_score_increase);
  assert.deepEqual(E.DEFAULTS.tiers, { amber: w2cfg.amber_min, red: w2cfg.red_above });
  assert.match(api, /const TIERS = \{ amber: 40, red: 65 \}, RATIO_FULL = 0\.5;/);
  for (const n of ['Condense Archive', 'Condense Climate', 'Score Segments']) assert.match(W2.nodes.find((x) => x.name === n).parameters.jsCode, /return score >= RED \? 'red'/);
});

test('W2 scores four hazards; the worst one sets risk_score and tier; nothing is uniform by construction', async () => {
  const models = { MRI_AGCM3_2_S: ratios({ dry: 2, spell: 1.5, fire: 1.4 }), EC_Earth3P_HR: ratios({ dry: 2, spell: 1.5, fire: 1.4 }), MPI_ESM1_2_XR: ratios({ dry: null, spell: 1.5, fire: null }) };
  const rows = await scoreW2([w2seg('s_cross', JSON.stringify([{ name: 'Mill Creek', kind: 'stream', at: [-113.4, 53.4], peakFlowM3s: null }])), w2seg('s_none', '[]'), w2seg('s_unchecked', null)], cellRec(models));
  assert.equal(rows.length, 6);
  const h = (id, y) => { const r = rows.find((x) => x.segment_id === id && x.horizon_years === y); return { r, hz: JSON.parse(r.hazards_json) }; };
  const a = h('s_cross', 10);
  assert.equal(a.r.status, 'verified');
  assert.deepEqual(Object.keys(a.hz.hazards).sort(), ['crossing', 'drought', 'ground', 'wildfire']);
  assert.equal(a.hz.hazards.drought.score, 100);                       // dry soil x2 and dry spell +50% are both full at ratioFull 0.5
  assert.equal(a.hz.hazards.crossing.score, Math.round(1000 * (0.4 * 0.4) / 0.75) / 10);   // stream, rain unchanged, no flow data: re-weighted, not zero-filled
  assert.match(a.hz.status.crossing, /scored without river flow/);
  assert.equal(a.hz.hazards.wildfire.models_with_humidity, 2);
  assert.match(a.hz.hazards.wildfire.why, /5 to 7 a year \(\+40%\)/);
  assert.equal(a.r.hazard, 'drought'); assert.equal(a.r.risk_score, 100); assert.equal(a.r.tier, 'red');
  assert.ok(a.r.ground_score < 5, 'ground failure stays low: the level is the worst hazard, never a blend');
  // No mapped crossing is "not applicable"; never checked is "not checked". Neither is a score.
  const b = h('s_none', 10), c = h('s_unchecked', 10);
  assert.equal(b.hz.hazards.crossing, undefined); assert.match(b.hz.status.crossing, /^not applicable/); assert.deepEqual(b.hz.crossings, []);
  assert.equal(c.hz.hazards.crossing, undefined); assert.match(c.hz.status.crossing, /^not checked/); assert.equal(c.hz.crossings, null);
  const scores = Object.values(a.hz.hazards).map((x) => x.score);
  assert.equal(new Set(scores).size, scores.length, 'the four hazard scores differ');
});

test('W2 never invents humidity or dry-soil data: missing inputs leave the hazard out with a reason', async () => {
  const noRh = { MRI_AGCM3_2_S: ratios({ fire: null, dry: null }), EC_Earth3P_HR: ratios({ fire: null, dry: null }), MPI_ESM1_2_XR: ratios({ fire: null, dry: null }) };
  const r = (await scoreW2([w2seg('s', '[]')], cellRec(noRh))).find((x) => x.horizon_years === 10);
  const hz = JSON.parse(r.hazards_json);
  assert.equal(hz.hazards.wildfire, undefined); assert.match(hz.status.wildfire, /^unavailable: no climate model provided humidity/);
  assert.match(hz.status.drought, /dry spells only/);
  const oldCache = (await scoreW2([w2seg('s', '[]')], cellRec({ MRI_AGCM3_2_S: ratios({}), EC_Earth3P_HR: ratios({}), MPI_ESM1_2_XR: ratios({}) }, { fire: undefined }))).find((x) => x.horizon_years === 10);
  assert.match(JSON.parse(oldCache.hazards_json).status.wildfire, /no observed humidity in the cached baseline/);
});

test('W2 helper counts dry-soil days, dry spells and fire-weather days, and returns null without humidity', () => {
  const code = W2.nodes.find((n) => n.name === 'Condense Archive').parameters.jsCode;
  const helper = code.slice(0, code.indexOf('// ===== Condense the'));
  const { seriesMetrics } = new Function('$', helper + '\nreturn { seriesMetrics };')(() => ({ first: () => ({ json: w2cfg }) }));
  const time = [], pr = [], tx = [], tn = [], sm = [], rh = [];
  for (let y = 1995; y <= 2035; y++) for (let d = 0; d < 365; d++) {
    const dt = new Date(Date.UTC(y, 0, 1 + d)); time.push(dt.toISOString().slice(0, 10));
    const summer = d >= 180 && d < 240, future = y >= 2026;
    pr.push(summer && d < (future ? 220 : 200) ? 0 : 3);                 // dry spell: 20 days in the baseline, 40 in the future
    tx.push(summer ? 28 : 5); tn.push(summer ? 12 : -3);
    sm.push(summer ? 0.1 : 0.3); rh.push(summer ? 30 : 70);
  }
  const m = seriesMetrics(time, pr, tx, tn, sm, rh);
  assert.equal(m.ok, true);
  assert.ok(Math.abs(m.base.spell - 20) < 0.01 && Math.abs(m.windows[10].spell - 40) < 0.01, 'longest dry spell doubles');
  assert.ok(Math.abs(m.base.fire - 20) < 0.1 && Math.abs(m.windows[10].fire - 40) < 0.1, 'fire-weather days: dry, hot, low humidity');
  assert.equal(seriesMetrics(time, pr, tx, tn, sm, null).base.fire, null, 'no humidity series means no fire-weather count, not zero');
  assert.equal(seriesMetrics(time, pr, tx, tn, null, rh).base.dry, null, 'no soil series means no dry-soil count, not zero');
});

test('B regression: the cached Trans-Northern climate cells do not turn the whole corridor red at 10 years', async () => {
  // Real condensed cells as fetched on 2026-11-15. Climate is shared by every segment in a 10 km cell,
  // so if the climate terms alone can cross the red line, every kilometre goes red together (the bug).
  const cells = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cache', 'cells', 'trans-northern-cells.json'), 'utf8'));
  for (const c of cells) {
    const rec = { cell_key: 'cellA', cache_status: 'cached', archive: JSON.parse(c.archive_metrics_json), climate: JSON.parse(c.climate_metrics_json) };
    const flat = (await scoreW2([w2seg('flat', '[]')], rec)).find((x) => x.horizon_years === 10);   // flat ground, stable vegetation
    assert.equal(flat.status, 'verified', c.cell_key + ': ' + flat.error_message);
    assert.ok(flat.ground_score < w2cfg.amber_min, `${c.cell_key}: climate alone gives ground score ${flat.ground_score}, must stay below Medium`);
    const old = (await scoreW2([w2seg('flat', '[]')], rec, { ratio_full_score_increase: 0.15, red_above: 50 })).find((x) => x.horizon_years === 10);
    assert.ok(old.ground_score > 50, `${c.cell_key}: the previous live config (full at +15%, red above 50) made flat ground ${old.ground_score}: the mass-red bug`);
  }
});
