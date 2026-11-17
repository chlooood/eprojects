// Growth model: measured stages, seeded Monte Carlo, the 2016 hindcast, and the pipe-order rule built on it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const CLASS = require('../src/classlocation.js'), DECISION = require('../src/decision.js'), GROWTH = require('../src/growth.js');
const root = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const DATA = read('data/platform/ab-strathcona-demo.json');
const fitData = read('data/cache/growth/edmonton-growth-fit-2026-11-16.json');
const AS_OF = '2026-11-16';

test('growth: stages are fitted from the cached city records', () => {
  const f = GROWTH.fit(fitData);
  assert.strictEqual(f.summary.neverShare, 0.448);
  assert.strictEqual(f.summary.curedFromPlans, 27);
  assert.strictEqual(f.summary.finishedBlocks, 303);
  assert.ok(f.summary.devToBuildingRate > 0.95 && f.summary.devToBuildingRate < 1);
  assert.strictEqual(f.summary.moveInMedianMonths, 8.5);
  // a block next to one that started recently is far more likely to start than one with nothing nearby
  assert.ok(f.hazard.adjRecent.perYear > 2 * f.hazard.none.perYear, JSON.stringify(f.hazard));
  for (const b of GROWTH.BUCKETS) assert.ok(f.hazard[b].perYear > 0 && f.hazard[b].perYear < 1);
  // fitting as of 2016 sees only what was known then
  const old = GROWTH.fit(fitData, { cutoffYear: 2016 });
  assert.strictEqual(old.summary.neverShare, 0.629);
});

test('growth: build-out share rises from 0 to 1 and histogram draws stay in range', () => {
  const c = GROWTH.fitBuildout([[2015, 1, 3, 50]])[0];
  let prev = -1;
  for (let t = -1; t <= 8; t += 0.25) { const s = GROWTH.share(c, t); assert.ok(s >= prev && s >= 0 && s <= 1); prev = s; }
  assert.strictEqual(GROWTH.share(c, c.t50), 0.5);
  assert.strictEqual(GROWTH.share(c, 99), 1);
  const r = GROWTH.rng(7), hist = [0, 5, 10, 2];
  for (let i = 0; i < 500; i++) { const m = GROWTH.sampleHist(hist, r); assert.ok(m >= 1 && m < 15, String(m)); }
  for (let i = 0; i < 200; i++) assert.ok(GROWTH.sampleHist(hist, r, 2.5) >= 2.5);
});

test('growth: seeded futures repeat, chances only rise with time, today matches the class engine', () => {
  const opts = { runs: 200, asOf: AS_OF, to: '2035-12-31' };
  const a = GROWTH.simulate(DATA.segments, DATA.permits, fitData, opts), b = GROWTH.simulate(DATA.segments, DATA.permits, fitData, opts);
  assert.deepStrictEqual(a.bySegment, b.bySegment);
  const now = CLASS.forecast(DATA.segments, DATA.permits, CLASS.DEFAULTS, AS_OF).bySegment;
  for (const [id, s] of Object.entries(a.bySegment)) {
    assert.strictEqual(s.classNow, now[id] ? now[id].class.now : 1);
    let p2 = 0, p3 = 0;
    for (const y of a.years) { const v = s.byYear[y]; assert.ok(v[2] >= p2 && v[3] >= p3 && v[3] <= v[2] + 1e-9, id + ' ' + y); p2 = v[2]; p3 = v[3]; }
    if (s.next) { const c = s.cross[s.next]; if (c.p) assert.ok(c.q10 <= c.q50 && c.q50 <= c.q90); }
  }
  let prev = 0;
  for (const yb of a.bins) { const t = yb.added.reduce((x, n) => x + n, 0); assert.ok(t >= prev - 1e-6); prev = t; }
  // km 5 to 6 sits beside planned land that is building out: it should be likely, not certain, to reach Class 2
  const km5 = Object.values(a.bySegment).find((s, i) => DATA.segments.find((x) => x.id === Object.keys(a.bySegment)[i]).kmFrom === 5);
  assert.ok(km5.headline.p > 0.6 && km5.headline.p < 1, JSON.stringify(km5.headline));
});

test('growth: the 2016 hindcast scores itself against what happened', () => {
  const h = GROWTH.hindcast(DATA.segments, DATA.permits, fitData, { runs: 200 });
  assert.strictEqual(h.asOf, '2016-12-31');
  assert.ok(h.segmentBrier >= 0 && h.segmentBrier < 0.25);
  assert.ok(h.blocks.planned > 0 && h.blocks.startedSince <= h.blocks.planned);
  assert.ok(h.segmentChanges.every((x) => x.predicted >= 0 && x.predicted <= 1 && typeof x.happened === 'boolean'));
});

test('decision: order pipe when the chance of a change inside the lead window passes the threshold', () => {
  const samples = Array.from({ length: 80 }, (_, i) => 2027 + i / 40); // 80 of 100 futures change, spread over 2027 and 2028
  const o = { now: 2026.9, leadMonths: 8, buildMonths: 12, clockMonths: 6 };
  const half = DECISION.orderSignal(samples, 100, { ...o, threshold: 0.5 });
  assert.strictEqual(half.windowMonths, 14);
  assert.ok(half.pWithin > 0.3 && half.pWithin < 0.5, String(half.pWithin));
  assert.strictEqual(half.orderNow, false);
  assert.ok(Math.abs(half.orderBy - (samples[49] - 14 / 12)) < 1e-9);
  assert.strictEqual(DECISION.orderSignal(samples, 100, { ...o, threshold: 0.3 }).orderNow, true);
  assert.strictEqual(DECISION.orderSignal(samples, 100, { ...o, threshold: 0.9 }).orderBy, null);
  // a 24-month clock (PHMSA) is longer than lead plus build: order after the change, not before
  const us = DECISION.orderSignal(samples, 100, { ...o, clockMonths: 24 });
  assert.strictEqual(us.needed, false);
  assert.strictEqual(us.orderNow, false);
});
