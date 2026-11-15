// Renewables screening: scoring boundaries, fail-closed missing data, corridor isolation, scenario maths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../src/renewables.js');
const root = path.join(__dirname, '..');
const load = (id) => JSON.parse(fs.readFileSync(path.join(root, 'data/renewables', id, 'inputs.json'), 'utf8'));
const CORRIDORS = ['ab-strathcona-demo', 'bc-coquihalla'];

const solar = (o = {}) => ({ id: 'x_solar', corridorId: 'ab-strathcona-demo', tech: 'solar', side: 'L', kmFrom: 0, kmTo: 1, segmentIds: ['s'],
  resource: { pvout: 1250, ...(o.resource || {}) }, land: { usableHa: 10, slopeMedianPct: 3, protectedPct: 0, ...(o.land || {}) },
  grid: { stationKm: 1, searchKm: 30, ...(o.grid || {}) } });
const wind = (o = {}) => ({ id: 'x_wind', corridorId: 'ab-strathcona-demo', tech: 'wind', side: 'R', kmFrom: 0, kmTo: 2, segmentIds: ['s'],
  resource: { ws100: 8.2, ws100Usable: 8.2, cfGross: 0.4, ...(o.resource || {}) }, land: { usableHa: 150, slopeMedianPct: 4, protectedPct: 0, ...(o.land || {}) },
  grid: { stationKm: 2, searchKm: 30, ...(o.grid || {}) } });
const f = (a, k) => a.factors.find((x) => x.key === k);

test('factor ramps hit their stated end points exactly', () => {
  assert.equal(f(R.assess(solar({ resource: { pvout: 900 } })), 'resource').score, 0);
  assert.equal(f(R.assess(solar({ resource: { pvout: 1600 } })), 'resource').score, 100);
  assert.equal(f(R.assess(solar({ resource: { pvout: 1250 } })), 'resource').score, 50);
  assert.equal(f(R.assess(solar({ resource: { pvout: 2000 } })), 'resource').score, 100, 'clamped above');
  assert.equal(f(R.assess(wind({ resource: { ws100Usable: 5 } })), 'resource').score, 0);
  assert.equal(f(R.assess(wind({ resource: { ws100Usable: 9 } })), 'resource').score, 100);
  assert.equal(f(R.assess(solar({ land: { slopeMedianPct: 15 } })), 'terrain').score, 0);
  assert.equal(f(R.assess(solar({ grid: { stationKm: 15 } })), 'grid').score, 0);
  assert.equal(f(R.assess(solar({ grid: { stationKm: 0.5 } })), 'grid').score, 100);
});

test('score is the weighted sum of factor scores and status bands are inclusive at 70 and 45', () => {
  const a = R.assess(solar());
  const manual = a.factors.reduce((s, x) => s + x.weight * x.score, 0);
  assert.equal(a.score, Math.round(manual * 10) / 10);
  // all perfect -> 100 strong
  assert.equal(R.assess(solar({ resource: { pvout: 1600 } })).status, 'strong');
  const perfect = solar({ resource: { pvout: 1600 } });
  assert.equal(R.assess(perfect, { ...R.DEFAULTS, bands: { strong: 100, moderate: 45 } }).status, 'strong', 'inclusive at the strong boundary');
  assert.equal(R.assess(perfect, { ...R.DEFAULTS, bands: { strong: 100.1, moderate: 100 } }).status, 'moderate', 'inclusive at the moderate boundary');
  assert.equal(R.assess(perfect, { ...R.DEFAULTS, bands: { strong: 100.2, moderate: 100.1 } }).status, 'weak');
});

test('a weak resource caps the status at moderate even when the site is otherwise ideal', () => {
  const a = R.assess(wind({ resource: { ws100Usable: 6.8 } }));
  assert.ok(a.score >= 70, 'site score is high');
  assert.equal(a.status, 'moderate');
  assert.match(a.reason, /held at moderate/);
});

test('missing grid distance is incomplete, unranked and never zero-cost', () => {
  const c = solar({ grid: { stationKm: null, reason: null } });
  const a = R.assess(c);
  assert.equal(a.status, 'incomplete');
  assert.equal(a.score, null);
  assert.deepEqual(a.missing, ['grid']);
  assert.equal(f(a, 'grid').score, null);
  assert.ok(a.coverage < 100);
  const s = R.scenario(c, a, R.assumptionValues('ab-strathcona-demo'));
  assert.equal(s.connectionCost, null);
  assert.equal(s.capex, null, 'capex must not be computed without a connection cost');
  assert.equal(s.paybackYears, null);
  assert.match(s.reasons.join(' '), /grid distance unknown/);
});

test('missing resource or land eligibility makes a candidate incomplete, not feasible', () => {
  for (const c of [solar({ resource: { pvout: null } }), wind({ resource: { ws100: null, ws100Usable: null } }), solar({ land: { usableHa: null } })]) {
    const a = R.assess(c);
    assert.equal(a.status, 'incomplete', c.tech);
    assert.equal(a.score, null);
    assert.doesNotMatch(a.explanation, /feasible/i);
  }
  const s = R.scenario(wind({ resource: { cfGross: null } }), R.assess(wind({ resource: { cfGross: null } })), R.assumptionValues('ab-strathcona-demo'));
  assert.equal(s.mwh, null); assert.equal(s.revenue, null);
});

test('no substation within the search radius is a known worst case, not unknown', () => {
  const a = R.assess(solar({ grid: { stationKm: null, reason: 'no mapped transformer station within 30 km', searchKm: 30 } }));
  assert.notEqual(a.status, 'incomplete');
  assert.equal(f(a, 'grid').score, 0);
  assert.match(f(a, 'grid').display, /more than 30/);
});

test('exclusions: protected share and minimum usable area', () => {
  assert.equal(R.assess(solar({ land: { protectedPct: 50 } })).status, 'excluded');
  assert.equal(R.assess(solar({ resource: { pvout: 1600 }, land: { protectedPct: 49.9 } })).status, 'strong');
  assert.equal(R.assess(solar({ land: { usableHa: 1.9 } })).status, 'excluded');
  assert.equal(R.assess(solar({ land: { usableHa: 2 } })).status !== 'excluded', true);
  assert.equal(R.assess(wind({ land: { usableHa: 19.9 } })).status, 'excluded');
  assert.equal(R.assess(wind({ land: { usableHa: 19.9 } })).score, null);
});

test('no status or explanation ever claims feasibility; gates are always listed', () => {
  for (const id of CORRIDORS) for (const r of R.assessCorridor(load(id)).rows) {
    assert.ok(!/feasible/i.test(r.statusLabel + ' ' + r.explanation), r.id);
    assert.ok(r.gates.length >= 3);
    assert.match(r.explanation, /Not checked: land ownership/);
  }
});

test('scenario maths: solar and wind', () => {
  const A = R.assumptionValues('ab-strathcona-demo');
  const c = solar(), s = R.scenario(c, R.assess(c), A);
  assert.equal(s.mw, 10 * A.solar.densityMwPerHa);
  assert.equal(s.mwh, Math.round(s.mw * 1250));
  assert.equal(s.revenue, Math.round(s.mwh * A.priceCadPerMwh * A.solar.captureRatio));
  assert.equal(s.landIncluded, false, 'land cost is not assumed to be zero; it is reported as excluded');
  const w = wind(), sw = R.scenario(w, R.assess(w), A);
  assert.equal(sw.turbines, Math.floor((150 / 100) * A.wind.densityMwPerKm2 / A.wind.turbineMw));
  const tiny = wind({ land: { usableHa: 25 } }), st = R.scenario(tiny, R.assess(tiny), A);
  assert.equal(st.turbines, 0); assert.match(st.reasons.join(' '), /less than one/);
  const withLand = R.scenario(c, R.assess(c), R.assumptionValues('ab-strathcona-demo', { landCostCadPerHaYr: 1000 }));
  assert.equal(withLand.net, withLand.netBeforeLand - 10 * 1000);
});

test('every default assumption names a source or says it is a placeholder', () => {
  const walk = (o) => Object.values(o).forEach((v) => (v && typeof v === 'object' && 'value' in v ? assert.ok(v.source && v.source.length > 5) : v && typeof v === 'object' && walk(v)));
  walk(R.ASSUMPTIONS);
});

test('corridor isolation: IDs, segments and inputs never cross corridors', () => {
  const segIds = {
    'ab-strathcona-demo': new Set(JSON.parse(fs.readFileSync(path.join(root, 'data/snapshot/live-snapshot.json'))).segments.map((s) => s.id)),
    'bc-coquihalla': new Set(JSON.parse(fs.readFileSync(path.join(root, 'data/corridors/bc-coquihalla/assessment.json'))).segments.map((s) => s.id)),
  };
  for (const id of CORRIDORS) {
    const inp = load(id);
    assert.equal(inp.corridorId, id);
    for (const c of inp.candidates) {
      assert.equal(c.corridorId, id);
      assert.ok(c.id.startsWith(`rn_${id}_`), c.id);
      for (const s of c.segmentIds) assert.ok(segIds[id].has(s), `${c.id} references foreign segment ${s}`);
    }
    for (const other of CORRIDORS.filter((x) => x !== id)) for (const c of inp.candidates) for (const s of c.segmentIds) assert.ok(!segIds[other].has(s));
  }
  const mixed = load('ab-strathcona-demo'); mixed.candidates = mixed.candidates.concat(load('bc-coquihalla').candidates.slice(0, 1));
  assert.throws(() => R.assessCorridor(mixed), /belongs to bc-coquihalla/);
});

test('renewables module reads no pipeline risk and the saved pipeline data still matches its source', () => {
  const src = fs.readFileSync(path.join(root, 'src/renewables.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\.risk\b|riskScore|workOrder|tier\b/);
  // Cached inputs keep provenance for every source.
  for (const id of CORRIDORS) for (const s of load(id).sources) {
    assert.match(s.rawSha256, /^[0-9a-f]{64}$/, s.key);
    assert.ok(s.url && s.licence && s.retrievedAt && s.resolution, s.key);
  }
});

test('real cached inputs: every candidate has a resource value, coverage and a stated status', () => {
  for (const id of CORRIDORS) {
    const a = R.assessCorridor(load(id));
    assert.ok(a.rows.length > 0);
    for (const r of a.rows) assert.ok(['strong', 'moderate', 'weak', 'excluded', 'incomplete'].includes(r.status));
    for (const t of ['solar', 'wind']) assert.ok(a.pooled[t]);
  }
});

test('CSV export has one header and one row per candidate, quoted safely', () => {
  const inp = load('bc-coquihalla'), a = R.assessCorridor(inp);
  const csv = R.toCSV(a.rows, Object.fromEntries(inp.candidates.map((c) => [c.id, c])));
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, a.rows.length + 1);
  assert.ok(lines[0].startsWith('id,corridorId,tech'));
});
