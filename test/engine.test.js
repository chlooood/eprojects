const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');

function daily(years, fn) {
  const time = [], pr = [], tmin = [], tmax = [], soil = [];
  for (const y of years) for (let d = 0; d < 365; d++) {
    const date = new Date(Date.UTC(y, 0, 1 + d)).toISOString().slice(0, 10);
    const v = fn(y, d);
    time.push(date); pr.push(v.pr); tmin.push(v.tmin); tmax.push(v.tmax); soil.push(v.soil);
  }
  return { time, precipitation_sum: pr, temperature_2m_min: tmin, temperature_2m_max: tmax, soil_moisture_0_to_10cm_mean: soil };
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('segmentRoute cuts a 10.5 km straight line into 10 full segments and keeps the tail', () => {
  // ~0.009 deg latitude is about 1 km
  const route = [[-113, 53], [-113, 53 + 0.0945]];
  const segs = E.segmentRoute(route);
  assert.equal(segs.length, 11);
  for (const s of segs.slice(0, 10)) assert.ok(Math.abs(s.lengthM - 1000) < 2, s.lengthM);
  assert.equal(segs[0].id, 'KP000');
  assert.equal(segs[0].studyPolygon.length, 5);
  // samples sit 130 m off the centreline, outside the 30 m band
  const d = E.haversine(segs[0].mid, segs[0].samples[0]);
  assert.ok(Math.abs(d - 130) < 2, d);
});

test('segmentRoute rejects a route with one point', () => {
  assert.throws(() => E.segmentRoute([[0, 0]]));
});

test('baselineStats counts extreme, freeze-thaw and wet-soil days per year', () => {
  const d = daily(range(2000, 2009), (y, day) => ({
    pr: day % 10 === 0 ? (day === 0 ? 50 : 5) : 0,
    tmin: day < 30 ? -5 : 5, tmax: day < 30 ? 2 : 15,
    soil: day < 37 ? 0.4 + day * 0.001 : 0.2 + day * 0.0001,
  }));
  const b = E.baselineStats(d);
  assert.equal(b.years, 10);
  assert.equal(b.freezeThawDaysPerYr, 30);
  assert.ok(b.extremeDaysPerYr >= 0.9 && b.extremeDaysPerYr <= 1.1, String(b.extremeDaysPerYr));
  assert.ok(b.wetSoilDaysPerYr > 30 && b.wetSoilDaysPerYr <= 37);
});

test('quantile ignores nulls', () => {
  assert.equal(E.quantile([null, 1, 2, 3, NaN], 0.5), 2);
  assert.equal(E.quantile([], 0.5), null);
});

test('splitModels separates Open-Meteo climate keys by model suffix', () => {
  const raw = { time: ['2026-01-01'], precipitation_sum_MRI_AGCM3_2_S: [1], precipitation_sum_EC_Earth3P_HR: [2], temperature_2m_min_MRI_AGCM3_2_S: [-1] };
  const s = E.splitModels(raw, ['MRI_AGCM3_2_S', 'EC_Earth3P_HR']);
  assert.deepEqual(s.MRI_AGCM3_2_S.precipitation_sum, [1]);
  assert.deepEqual(s.EC_Earth3P_HR.precipitation_sum, [2]);
  assert.deepEqual(s.MRI_AGCM3_2_S.temperature_2m_min, [-1]);
});

test('projectedStats uses each model\'s own history (delta method) and treats empty soil as missing', () => {
  const years = Array.from({ length: 42 }, (_, i) => 1995 + i);
  // model is biased wet (2x observed rain) in BOTH its past and future: no real change
  const model = daily(years, (y, day) => ({ pr: day % 5 === 0 ? (day % 50 === 0 ? 40 : 4) : 0, tmin: -1, tmax: 1, soil: null }));
  const observed = { extremeMm: 10, extremeDaysPerYr: 1, freezeThawDaysPerYr: 365, wetSoilDaysPerYr: 36, soilWetThreshold: 0.3 };
  const p = E.projectedStats({ M: model }, observed, [2026, 2036]);
  assert.equal(p.M.method, 'delta');
  assert.equal(p.M.wetSoilDaysPerYr, null);
  assert.equal(p.M.refWetSoilDaysPerYr, null);
  assert.equal(p.M.extremeDaysPerYr, p.M.refExtremeDaysPerYr);
});

test('ndviTrend finds a declining growing-season trend', () => {
  const series = [];
  for (const y of range(2019, 2025)) for (const m of [5, 6, 7, 8, 9]) series.push({ date: `${y}-0${m}-01`, ndvi: 0.7 - 0.02 * (y - 2019) });
  const t = E.ndviTrend(series);
  assert.ok(Math.abs(t.slopePerYr + 0.02) < 0.002, String(t.slopePerYr));
  assert.ok(t.change5yr < -0.09);
  assert.equal(E.ndviTrend(series.slice(0, 3)), null);
});

function segWith(projRain, extra = {}) {
  return {
    id: 'KP001', lengthM: 1000, studyAreaAcres: 98.8, slopePct: 4, irradiance: 3.5, substationKm: 5,
    baseline: { extremeDaysPerYr: 4, freezeThawDaysPerYr: 60, wetSoilDaysPerYr: 36, extremeMm: 20, soilWetThreshold: 0.35 },
    projections: { y10: { A: { extremeDaysPerYr: projRain, freezeThawDaysPerYr: 60, wetSoilDaysPerYr: 36 }, B: { extremeDaysPerYr: projRain, freezeThawDaysPerYr: 60, wetSoilDaysPerYr: 36 }, C: { extremeDaysPerYr: projRain, freezeThawDaysPerYr: 60, wetSoilDaysPerYr: 36 } } },
    ndvi: { change5yr: 0 },
    ...extra,
  };
}

test('riskScore: no change scores low and green, doubling rain plus steep slope and vegetation loss goes red', () => {
  const calm = E.riskScore(segWith(4), 'y10');
  assert.equal(calm.tier, 'green');
  assert.ok(calm.score < 10);
  const bad = segWith(8, { slopePct: 15, ndvi: { change5yr: -0.12 } });
  for (const m of Object.values(bad.projections.y10)) m.wetSoilDaysPerYr = 54;
  const badR = E.riskScore(bad, 'y10');
  assert.equal(badR.tier, 'red');
  assert.equal(badR.agreement, 'high');
  assert.equal(badR.drivers[0].key, 'rain');
  assert.equal(badR.drivers[0].change, 100);
});

test('riskScore fails closed when data is missing', () => {
  const r = E.riskScore({ id: 'x', slopePct: 3 }, 'y10');
  assert.equal(r.tier, 'unverified');
  assert.equal(r.score, null);
  assert.deepEqual(r.missing, ['baseline', 'projections']);
});

test('riskScore marks red with disagreeing models as uncertain', () => {
  const s = segWith(8, { slopePct: 15, ndvi: { change5yr: -0.2 } });
  for (const m of Object.values(s.projections.y10)) m.wetSoilDaysPerYr = 54;
  s.projections.y10.B.extremeDaysPerYr = 3;
  s.projections.y10.C.extremeDaysPerYr = 4;
  s.projections.y10.A.extremeDaysPerYr = 20;
  const r = E.riskScore(s, 'y10');
  assert.equal(r.agreement, 'low');
  assert.equal(r.tier, 'red-uncertain');
});

test('riskScore uses learned coefficients when a model is given', () => {
  const model = { intercept: -3, coefficients: { rain: 4, freezeThaw: 0, saturation: 0, slope: 1 } };
  const r = E.riskScore(segWith(8), 'y10', E.DEFAULTS, model);
  assert.equal(r.method, 'logistic-regression');
  assert.ok(r.score > 70 && r.score < 80, String(r.score)); // sigmoid(1.27) ~ 78
});

test('buildScore: flat sunny land near a substation is green; steep land is excluded; red risk halves the score', () => {
  const s = segWith(4, { irradiance: 4.5, slopePct: 1, substationKm: 1 });
  const b = E.buildScore(s, { tier: 'green' });
  assert.equal(b.tier, 'green');
  const acres = (1000 * E.DEFAULTS.buildStripM) / 4046.86; // panel strip only, not the 98.8-acre study area
  assert.ok(Math.abs(b.mw - acres / 6) < 0.01);
  assert.ok(Math.abs(b.leaseYr - acres * E.DEFAULTS.money.leaseRatePerAcreYr) <= 1);
  // A strip wider than the study area is capped at the study area.
  const wide = E.buildScore(s, { tier: 'green' }, E.mergeConfig({ buildStripM: 5000 }));
  assert.ok(Math.abs(wide.usableAcres - 98.8) < 0.01);
  assert.equal(b.partnerYr + b.operatorYr, b.leaseYr);
  const halved = E.buildScore(s, { tier: 'red' });
  assert.ok(Math.abs(halved.score - b.score / 2) < 0.1);
  assert.equal(E.buildScore({ ...s, slopePct: 12 }, null).tier, 'excluded');
});

test('moneyForSegment: higher score means higher expected loss; a work order avoids 75% of it', () => {
  const lo = E.moneyForSegment({ score: 10 }, 10), hi = E.moneyForSegment({ score: 90 }, 10);
  assert.ok(hi.expectedLoss > lo.expectedLoss * 5);
  assert.equal(hi.avoidedIfFixed, Math.round(hi.expectedLoss * 0.75));
  assert.equal(E.moneyForSegment({ score: null }, 10), null);
});

test('corridorSummary ranks top risks and totals the money', () => {
  const segs = [0, 1, 2, 3, 4].map((k, i) => {
    const s = segWith(4 + k / 2, { id: 'KP00' + i });   // rain +0% to +50%: stays under the ratioFull cap so the ranking is strict
    s.risk = { y10: E.riskScore(s, 'y10'), y5: E.riskScore(s, 'y10') };
    s.build = E.buildScore(s, s.risk.y10);
    return s;
  });
  const sum = E.corridorSummary(segs, E.DEFAULTS, { years: 10, topN: 2 });
  assert.equal(sum.top[0].id, 'KP004');
  assert.equal(sum.top.length, 2);
  assert.ok(sum.topShareOfLoss > 0.4);
  assert.equal(sum.segments, 5);
  assert.ok(sum.leaseRevenueYr >= 0);
  assert.equal(sum.breakEvenFailures, Math.round((50000 * 10 / 430000) * 100) / 100);
  assert.equal(sum.yearsPaidByOneFailure, 8.6);
});

test('corridorSummary counts lease only on green build stretches and inspection savings only on green risk km', () => {
  const good = segWith(4, { id: 'G', irradiance: 4.5, slopePct: 1, substationKm: 1 });
  const steep = segWith(4, { id: 'S', irradiance: 4.5, slopePct: 12, substationKm: 1 });
  for (const s of [good, steep]) { s.risk = { y10: E.riskScore(s, 'y10') }; s.build = E.buildScore(s, s.risk.y10); }
  const sum = E.corridorSummary([good, steep], E.DEFAULTS, { years: 10 });
  assert.equal(sum.leaseRevenueYr, good.build.leaseYr);
  assert.equal(sum.buildableKm, 1);
  // steep land at 12% slope still scores green on risk here (rain unchanged), so 2 green km
  assert.equal(sum.inspectionSavingsYr, Math.round(sum.greenKm * 500 * (2 / 3)));
});

test('workOrder: red is P1 due in 14 days with checks from its drivers; overrides change priority', () => {
  // rain doubles, plant cover falling, steep: score 65 -> red, rain still the top driver
  const s = segWith(8, { kmFrom: 1, kmTo: 2, mid: [-112.8, 53.3], slopePct: 20, ndvi: { change5yr: -0.12 } });
  s.risk = { y10: E.riskScore(s, 'y10', E.mergeConfig({ tiers: { amber: 40, red: 60 } })) };
  assert.equal(s.risk.y10.tier, 'red');
  const wo = E.workOrder(s, 'y10', E.DEFAULTS, { now: '2026-11-15T12:00:00Z', by: 'tester' });
  assert.equal(wo.id, 'WO-KP001-20261115');
  assert.equal(wo.priority, 'P1');
  assert.equal(wo.dueBy, '2026-11-29');
  assert.match(wo.checks[0], /Culverts/);                   // top driver is extreme rain
  assert.match(wo.checks[wo.checks.length - 1], /Photograph/);
  assert.equal(wo.mapUrl, 'https://www.google.com/maps?q=53.3,-112.8');
  assert.match(E.workOrderText(wo), /P1 field inspection KP001/);
  const ovr = E.workOrder({ ...s, override: { tier: 'amber' } }, 'y10', E.DEFAULTS, { now: '2026-11-15T12:00:00Z' });
  assert.equal(ovr.priority, 'P2');
  assert.equal(ovr.dueBy, '2027-01-14');
});

test('hazards: drought, wildfire and river crossing are scored on their own; the level is the worst one', () => {
  const s = segWith(4, { slopePct: 1 });   // rain unchanged, flat: ground failure ~0
  s.baseline = { ...s.baseline, drySoilDaysPerYr: 36, drySpellDays: 20, fireWeatherDaysPerYr: 5 };
  for (const m of Object.values(s.projections.y10)) Object.assign(m, { drySoilDaysPerYr: 72, refDrySoilDaysPerYr: 36, drySpellDays: 30, refDrySpellDays: 20, fireWeatherDaysPerYr: 7, refFireWeatherDaysPerYr: 5 });
  const r = E.riskScore(s, 'y10');
  assert.ok(r.groundScore < 5, String(r.groundScore));
  assert.equal(r.hazards.drought.score, 100);   // dry-soil days double (capped at full) and the dry spell is +50% = ratioFull, so both factors are 1
  assert.equal(r.hazard, 'drought');
  assert.equal(r.score, r.hazards.drought.score);
  assert.equal(r.tier, 'red');
  assert.match(r.hazards.wildfire.why, /5 to 7 a year \(\+40%\)/);
  assert.equal(r.hazards.crossing, undefined);                    // no crossing: not applicable, never "low"
  const x = E.riskScore({ ...s, crossings: [{ name: 'Test River', kind: 'river', peakFlowM3s: 200 }] }, 'y10');
  assert.equal(x.hazards.crossing.score, Math.round(100 * (0.4 * 1 + 0.25 * 1) / 1 * 10) / 10);  // size 1, flow 1, rain 0
  const wo = E.workOrder({ ...s, crossings: [{ name: 'Test River', kind: 'river', peakFlowM3s: 200 }], risk: { y10: x } }, 'y10');
  assert.match(wo.checks[0], /Drought|River crossing/);
  assert.match(wo.checks.join(' '), /River crossing/);
});

test('findCrossings: finds where a segment centreline crosses a waterway', () => {
  const segs = [{ id: 'KP000', centreline: [[0, 0], [0.01, 0]] }, { id: 'KP001', centreline: [[0.01, 0], [0.02, 0]] }];
  const xs = E.findCrossings(segs, [{ name: 'Creek', kind: 'stream', coords: [[0.015, -0.01], [0.015, 0.01]] }]);
  assert.deepEqual(Object.keys(xs), ['KP001']);
  assert.equal(xs.KP001[0].at[0], 0.015);
});

test('mergeConfig overrides nested money values without touching defaults', () => {
  const c = E.mergeConfig({ money: { costOfFailure: 11700000 } });
  assert.equal(c.money.costOfFailure, 11700000);
  assert.equal(c.money.acresPerMW, 6);
  assert.equal(E.DEFAULTS.money.costOfFailure, 430000);
});

test('ratioFull: a +50% rise is a full factor score, +15% is not, and the tier rule is >= red', () => {
  assert.equal(E.DEFAULTS.ratioFull, 0.5);
  assert.deepEqual(E.DEFAULTS.tiers, { amber: 40, red: 65 });
  const flat = { slopePct: 0 };
  assert.equal(E.riskScore(segWith(6, flat), 'y10').factors.rain, 1);            // 4 -> 6 days = +50%
  assert.equal(E.riskScore(segWith(4.6, flat), 'y10').factors.rain, 0.3);        // +15% is 0.3 of full, not full
  // The live corridor's 10-year climate signal (rain +15%, freeze-thaw +2%, wet soil +40%) on flat, stable ground stays Low.
  const s = segWith(4.6, flat);
  for (const m of Object.values(s.projections.y10)) Object.assign(m, { freezeThawDaysPerYr: 61.4, wetSoilDaysPerYr: 50.3 });
  const r = E.riskScore(s, 'y10');
  assert.equal(r.tier, 'green');
  assert.ok(r.score > 20 && r.score < 30, String(r.score));
  const tierAt = (v) => E.riskScore({ ...segWith(4, flat), crossings: [{ kind: 'river', peakFlowM3s: v }] }, 'y10').hazards.crossing;
  assert.equal(tierAt(200).score, 65);
  assert.equal(tierAt(200).tier, 'red');                                         // exactly 65 is High
});
