// Platform modules: segment core, class location, decision paths, land obligations, field feedback,
// ledger, exports, the join, and the real Code-node source of the four generated workflows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SEG = require('../src/segments.js'), CLASS = require('../src/classlocation.js'), DECISION = require('../src/decision.js'), OBL = require('../src/obligations.js');
const FEEDBACK = require('../src/feedback.js'), LEDGER = require('../src/ledger.js'), EXPORT = require('../src/export.js'), PLATFORM = require('../src/platform.js');
const root = path.join(__dirname, '..');
const snap = JSON.parse(fs.readFileSync(path.join(root, 'data/snapshot/live-snapshot.json'), 'utf8'));
const permits = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/edmonton-permits-2026-11-16.json'), 'utf8'));
const AS_OF = '2026-11-16';

// A straight test line running north, one segment per km (0.009044 degrees of latitude is 1 km on this projection).
const line = (n = 4) => Array.from({ length: n }, (_, i) => ({ id: 'S' + i, kmFrom: i, kmTo: i + 1, centreline: [[-113.4, 53.4 + i * 0.009044], [-113.4, 53.4 + (i + 1) * 0.009044]] }));
const cells = (o) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(',');

test('segment core: chainage, offset and overlap along the line', () => {
  const ix = SEG.buildIndex(line());
  assert.ok(Math.abs(ix.lengthM - 4000) < 5);
  const at = SEG.locate(ix, [-113.4 + 0.001, 53.4 + 1.5 * 0.009044]);
  assert.ok(Math.abs(at.chainageM - 1500) < 5 && Math.abs(at.offsetM - 66.4) < 2);
  assert.equal(SEG.segmentAt(ix, 1500), 'S1');
  assert.deepEqual(SEG.overlapping(ix, 900, 2100), ['S0', 'S1', 'S2']);
  assert.deepEqual(SEG.overlapping(ix, 2500, 2500), ['S2']);
  assert.equal(SEG.addMonths('2026-01-31', 1), '2026-02-28');
  assert.throws(() => SEG.buildIndex([]));
});

test('class location: thresholds are 11 and 46 dwelling units in the window', () => {
  assert.deepEqual([0, 10, 11, 45, 46, 400].map((u) => CLASS.classOf(u)), [1, 1, 2, 2, 3, 3]);
  assert.equal(CLASS.nextThreshold(5), 11); assert.equal(CLASS.nextThreshold(20), 46); assert.equal(CLASS.nextThreshold(60), null);
});

test('class location: issued permits forecast a change before the dwellings exist, with the regulator clock', () => {
  const data = { binM: 200, rooflines: { dataset: 'r', name: 'roof survey', asOf: '2019-12-31', cells: cells({ 2: 6 }) },
    buildingPermits: { dataset: 'bp', cells: '3,2026Q3,8,8', large: [['BP-1', '2026-06-01', 40, '315', 700]] } };
  const f = CLASS.forecast(line(), data, CLASS.DEFAULTS, AS_OF), a = f.bySegment.S0;
  assert.equal(a.status, 'change_committed');
  assert.deepEqual([a.class.now, a.class.committed], [1, 3]);
  assert.equal(a.units.existing, 6); assert.equal(a.units.committed, 48);
  assert.equal(a.change.steps[0].to, 2);                       // the 8 houses land first (9 month lag) and make it Class 2
  assert.equal(a.change.date, '2027-05-15');
  assert.equal(a.clock.due, '2027-11-15');                     // CER: plan within six months of the change
  assert.equal(a.clock.running, false);
  assert.equal(a.evidence[0].id, 'BP-1');
  const us = CLASS.forecast(line(), data, { ...CLASS.DEFAULTS, jurisdiction: 'US' }, AS_OF).bySegment.S0;
  assert.equal(us.clock.due, '2029-05-15');                    // 24 months, already past the March 2028 floor
});

test('class location: development permits are "possible", netted against building permits, never dated', () => {
  const data = { binM: 200, rooflines: { dataset: 'r', name: 'roofs', asOf: '2019-12-31', cells: cells({ 1: 3 }) },
    developmentPermits: { dataset: 'dp', since: '2024-01-01', large: [['DP-1', '2026-02-01', 30, 'cluster', 500, 'cluster housing']] },
    buildingPermits: { dataset: 'bp', large: [['BP-9', '2026-09-01', 10, '330', 500]] } };
  const a = CLASS.forecast(line(), data, CLASS.DEFAULTS, AS_OF).bySegment.S0;
  assert.equal(a.units.possible, 20);                          // 30 approved, 10 of them already have building permits
  assert.equal(a.units.committed, 10);
  assert.equal(a.status, 'change_committed'); assert.equal(a.class.committed, 2); assert.equal(a.class.possible, 2);
  const none = CLASS.forecast(line(), { ...data, buildingPermits: null }, CLASS.DEFAULTS, AS_OF).bySegment.S0;
  assert.equal(none.status, 'change_possible'); assert.equal(none.change.date, null); assert.equal(none.clock, null);
});

test('class location: no baseline count means a lower bound, and nothing at all means unverified, never Class 1', () => {
  const a = CLASS.forecast(line(), { binM: 200, buildingPermits: { dataset: 'bp', large: [['BP-1', '2021-01-01', 50, '315', 500]] } }, CLASS.DEFAULTS, AS_OF).bySegment.S0;
  assert.equal(a.class.isLowerBound, true); assert.equal(a.class.now, 3);
  const empty = CLASS.forecast(line(), {}, CLASS.DEFAULTS, AS_OF).bySegment.S0;
  assert.equal(empty.status, 'unverified');
});

test('class location: a change inside the last year means the clock is already running', () => {
  const data = { binM: 200, rooflines: { dataset: 'r', name: 'roofs', asOf: '2019-12-31', cells: cells({ 1: 8 }) }, buildingPermits: { dataset: 'bp', large: [['BP-2', '2025-06-01', 6, '110', 300]] } };
  const a = CLASS.forecast(line(), data, CLASS.DEFAULTS, AS_OF).bySegment.S0;
  assert.equal(a.status, 'changed'); assert.equal(a.change.date, '2026-02-01'); assert.equal(a.clock.due, '2026-08-01');
  assert.equal(a.clock.running, true); assert.ok(a.clock.monthsLeft < 0);
});

test('class location on the real Edmonton open data: the south end is filling in', () => {
  const f = CLASS.forecast(snap.segments, permits, CLASS.DEFAULTS, AS_OF);
  assert.equal(f.summary.segments, 23);
  assert.equal(f.summary.unverified, 0);
  const possible = Object.values(f.bySegment).filter((a) => a.status === 'change_possible');
  assert.equal(possible.length, 1);
  assert.equal(possible[0].change.to, 2);
  assert.ok(possible[0].evidence.length > 0 && possible[0].evidence.every((e) => e.dataset === '2ccn-pwtu'));
  const bt = CLASS.backtest(snap.segments, permits, CLASS.DEFAULTS, { to: AS_OF });
  assert.equal(bt.changes, 2);                                  // one kilometre went Class 1 -> 2 -> 3 between 2022 and 2023
  assert.ok(bt.rows.every((r) => r.flagged < r.changed));
  assert.match(bt.caveat, /assumed construction lag/);
  const total = permits.buildingPermits.cells.split(';').reduce((a, c) => a + +c.split(',')[3], 0) + permits.buildingPermits.large.reduce((a, r) => a + r[2], 0);
  assert.equal(total, permits.buildingPermits.unitsAdded);     // the compact cache still adds up to what was fetched
});

test('decision: every path is listed with a reason, the US-only path stays out of Canada', () => {
  const ca = DECISION.comparePaths({ from: 1, to: 3, jurisdiction: 'CA', lengthM: 1600, due: '2027-06-01', asOf: AS_OF });
  assert.equal(ca.paths.length, 6);
  const byKey = Object.fromEntries(ca.paths.map((p) => [p.key, p]));
  assert.equal(byKey.im_alternative.eligible, false); assert.match(byKey.im_alternative.why, /United States/);
  assert.equal(byKey.engineering_assessment.eligible, true);
  assert.equal(byKey.already_compliant.eligible, false); assert.ok(ca.unknowns.includes('pipe design records'));
  assert.equal(byKey.replace_pipe.meetsDeadline, false);        // 20 months of pipe lead time and construction, 6.5 months to the deadline
  assert.match(byKey.replace_pipe.materials.note, /has passed/);
  assert.equal(ca.pricedWithPlaceholders, true);
  const us = DECISION.comparePaths({ from: 2, to: 3, jurisdiction: 'US', lengthM: 1600, due: '2029-01-01', asOf: AS_OF });
  assert.equal(us.paths.find((p) => p.key === 'im_alternative').eligible, true);
  assert.equal(DECISION.comparePaths({ from: 1, to: 2, jurisdiction: 'US', lengthM: 1600, asOf: AS_OF }).paths.find((p) => p.key === 'im_alternative').eligible, false);
  const known = DECISION.comparePaths({ from: 1, to: 2, jurisdiction: 'CA', lengthM: 1600, asOf: AS_OF, pipe: { designClass: 3 } });
  assert.equal(known.lowestCost.key, 'already_compliant'); assert.equal(known.lowestCost.total, 0);
});

test('decision: the join. A geohazard flag costs the integrity path more; a dig wakes the land obligations', () => {
  const base = { from: 1, to: 3, jurisdiction: 'US', lengthM: 1600, due: '2029-01-01', asOf: AS_OF };
  const calm = DECISION.comparePaths(base).paths.find((p) => p.key === 'im_alternative');
  const flagged = DECISION.comparePaths({ ...base, geohazard: { tier: 'red', hazard: 'river crossing', why: 'bank erosion' } }).paths.find((p) => p.key === 'im_alternative');
  assert.ok(flagged.total > calm.total); assert.ok(flagged.conditions.some((c) => /river crossing/.test(c)));
  const obligations = [{ id: 'O1', requirement: 'notice', noticeHours: 48, triggers: ['ground_disturbance'], verified: false }, { id: 'O2', requirement: 'gate', triggers: ['any_entry'], verified: true }];
  const r = DECISION.comparePaths({ ...base, obligations });
  assert.deepEqual(r.paths.find((p) => p.key === 'replace_pipe').obligations.map((o) => o.id), ['O1']);
  assert.equal(r.paths.find((p) => p.key === 'pressure_reduction').obligations.length, 0);
});

test('decision: hingesOn names the assumption that flips the answer, and a sourced number clears its placeholder flag', () => {
  const change = { from: 1, to: 3, jurisdiction: 'US', lengthM: 1600, due: '2029-01-01', asOf: AS_OF };
  const cfg = DECISION.mergeAssumptions({ testFixedCost: 900000 });
  assert.equal(cfg.assumptions.testFixedCost.placeholder, false);
  assert.equal(DECISION.comparePaths(change, cfg).lowestCost.key, 'im_alternative');
  const h = DECISION.hingesOn(change, cfg);
  assert.ok(h.length > 0 && h.every((x) => x.flipsTo !== 'im_alternative'));
});

test('obligations: an AI extraction is kept only if its quote is in the document, and stays unverified', () => {
  const text = fs.readFileSync(path.join(root, 'data/obligations/commitment-table-format.txt'), 'utf8');
  const items = [
    { id: 'C-101', type: 'landowner_notice', requirement: '72 hours notice before ground disturbance', triggers: ['ground_disturbance'], noticeHours: 72, kmFrom: 5.2, kmTo: 6.4, quote: 'provide landowners with a   minimum of 72 hours notice prior to any ground disturbance' },
    { id: 'C-999', type: 'payment', requirement: 'Pay $5,000 per crossing', triggers: ['any_entry'], kmFrom: 5, kmTo: 6, quote: 'The Company will pay $5,000 for each crossing' },
    { id: 'C-103', type: 'reclamation', requirement: 'Reclaim within one growing season', triggers: ['ground_disturbance'], kmFrom: null, kmTo: null, quote: 'complete reclamation of disturbed agricultural land within one growing season' },
  ];
  const { accepted, rejected } = OBL.validateExtraction(items, text, 'format example');
  assert.deepEqual(accepted.map((o) => o.id), ['C-101']);
  assert.equal(accepted[0].verified, false); assert.equal(accepted[0].extractedBy, 'ai');
  assert.match(rejected.find((r) => r.id === 'C-999').problems.join(), /not found in the source/);
  assert.match(rejected.find((r) => r.id === 'C-103').problems.join(), /no location/);
  assert.match(OBL.extractionPrompt('x', 'd'), /word for word/);
});

test('obligations: a work order is checked against what sits on its kilometre', () => {
  const { obligations, rejected } = OBL.fromCsv(fs.readFileSync(path.join(root, 'data/obligations/TEMPLATE.csv'), 'utf8'));
  assert.equal(obligations.length, 3); assert.equal(rejected.length, 0);
  const ix = SEG.buildIndex(line(10)), pinned = OBL.pinToSegments(obligations, ix);
  assert.deepEqual(pinned.S5.map((o) => o.id), ['EXAMPLE-001', 'EXAMPLE-002']); assert.equal(pinned.S2.length, 0);
  const now = '2026-11-16T12:00:00.000Z';
  const walk = OBL.checkWorkOrder({ id: 'W1', segment: 'S5', kmFrom: 5, kind: 'inspection' }, pinned.S5, { now });
  assert.deepEqual(walk.steps.map((s) => s.id), ['EXAMPLE-001']);     // an inspection does not break ground
  assert.equal(walk.noticeHours, 48); assert.equal(walk.earliestStart, '2026-11-18T12:00:00.000Z');
  assert.equal(walk.status, 'needs_verification');                    // the obligation has not been confirmed by a person
  const dig = OBL.checkWorkOrder({ id: 'W2', segment: 'S5', kmFrom: 5, kind: 'dig', plannedStart: '2026-11-17T08:00:00.000Z' }, pinned.S5, { now });
  assert.equal(dig.steps.length, 2); assert.equal(dig.status, 'blocked'); assert.match(dig.summary, /km 5 needs 48 hours' notice/);
  assert.equal(OBL.checkWorkOrder({ segment: 'S2', kind: 'dig' }, pinned.S2, { now }).status, 'none_on_file');
  assert.equal(OBL.fromCsv('obligation_id,requirement\nX,').rejected.length, 1);
});

test('ledger: SHA-256 matches Node, decisions need a name and a reason, and tampering shows', () => {
  for (const s of ['', 'abc', 'kilometre 12 → Class 3 ' + 'x'.repeat(300)]) assert.equal(LEDGER.sha256(s), crypto.createHash('sha256').update(s).digest('hex'));
  assert.equal(LEDGER.canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), LEDGER.canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  const d = LEDGER.draft('class_location', 'S0', 'compliance_plan', { from: 1, to: 3 }, { at: 'T' });
  assert.equal(d.status, 'draft');
  assert.throws(() => LEDGER.draft('solar', 'S0', 'x', {}));
  assert.throws(() => LEDGER.decide([], d, { decision: 'approve' }), /name/);
  assert.throws(() => LEDGER.decide([], d, { decision: 'reject', by: 'A. Engineer' }), /reason/);
  let L = LEDGER.decide([], d, { decision: 'approve', by: 'A. Engineer', chosen: 'pressure_test', estimate: 346000, at: '2026-11-16T10:00:00Z' });
  assert.throws(() => LEDGER.decide(L, d, { decision: 'approve', by: 'B' }), /already decided/);
  L = LEDGER.recordOutcome(L, { segment: 'S0', module: 'class_location', finding: 'dwelling_count', value: 52, by: 'crew 4', at: '2026-12-01T10:00:00Z' });
  L = LEDGER.recordOutcome(L, { type: 'actual_cost', segment: 'S0', module: 'class_location', value: 410000, by: 'A. Engineer', at: '2027-03-01T10:00:00Z' });
  assert.deepEqual(LEDGER.verify(L), { ok: true, entries: 3, head: L[2].hash });
  assert.equal(LEDGER.statusOf(L, d), 'approved');
  const rec = LEDGER.decisionRecord(L, 'S0');
  assert.deepEqual(rec.map((r) => r.type), ['decision', 'finding', 'actual_cost']); assert.equal(rec[0].estimate, 346000); assert.equal(rec[2].value, 410000);
  const forged = JSON.parse(JSON.stringify(L)); forged[0].estimate = 1;
  assert.deepEqual(LEDGER.verify(forged), { ok: false, brokenAt: 1 });
  const pack = LEDGER.evidencePack({ id: 'S0', kmFrom: 0, kmTo: 1 }, L, [{ name: 'permits', content: 'abc' }], { at: 'T' });
  assert.equal(pack.chain.ok, true); assert.equal(pack.sources[0].sha256, LEDGER.sha256('abc')); assert.equal(pack.decisions.length, 3);
});

test('feedback: a crew count replaces the estimate, crosses modules, and is paired with what was predicted', () => {
  const built = PLATFORM.buildRecords(snap.segments, { permits }, {}, AS_OF);
  const rec = built.records.find((r) => r.classLocation.status === 'change_possible');
  const before = rec.classLocation.units.existing;
  assert.ok(FEEDBACK.normalize({ kind: 'dwelling_count', segment: rec.id, by: 'crew' }).problems.includes('needs a number'));
  assert.ok(FEEDBACK.normalize({ kind: 'bogus', segment: rec.id, by: 'x' }).problems.length);
  const findings = [
    FEEDBACK.normalize({ kind: 'dwelling_count', segment: rec.id, value: 14, by: 'crew 4', at: '2026-11-20T15:00:00Z' }).finding,
    FEEDBACK.normalize({ kind: 'new_structure', segment: rec.id, withinPrescribedArea: true, note: 'foundation poured', by: 'crew 4', at: '2026-11-20T15:05:00Z' }).finding,
  ];
  const after = PLATFORM.buildRecords(snap.segments, { permits, findings }, {}, AS_OF), r2 = after.records.find((r) => r.id === rec.id);
  assert.equal(r2.classLocation.units.existing, 14); assert.equal(r2.classLocation.units.estimatedBeforeCount, before);
  assert.equal(r2.classLocation.class.now, 2); assert.equal(r2.classLocation.fieldCounted, true);
  assert.equal(r2.encroachment.length, 1);                              // the class walkdown raised a right-of-way flag
  assert.ok(r2.drafts.some((d) => d.module === 'encroachment'));
  const label = after.labels.find((l) => l.kind === 'dwelling_count');
  assert.equal(label.error, 14 - before); assert.equal(label.agreed, false);
  assert.deepEqual(after.scoreboard.class_location, { findings: 2, comparable: 2, agreed: 1 });
});

test('platform: one record per kilometre joins the modules, and an approved draft becomes a checked work order', () => {
  const { obligations } = OBL.fromCsv(fs.readFileSync(path.join(root, 'data/obligations/TEMPLATE.csv'), 'utf8'));
  const events = [{ id: 'E1', kind: 'ground_disturbance', lon: snap.segments[3].centreline[0][0] + 0.0001, lat: snap.segments[3].centreline[0][1], observedAt: '2026-11-10', source: 'test' }];
  const built = PLATFORM.buildRecords(snap.segments, { permits, obligations, encroachmentEvents: events }, {}, AS_OF);
  assert.equal(built.records.length, 23);
  const rec = built.records.find((r) => r.classLocation.status === 'change_possible');
  assert.ok(rec.obligations.length >= 1);
  assert.ok(rec.decision.paths.find((p) => p.key === 'replace_pipe').obligations.length >= 1);     // a dig on this kilometre wakes the obligations
  assert.ok(rec.openItems.some((i) => i.module === 'class_location') && rec.openItems.some((i) => i.module === 'land_obligations'));
  assert.ok(built.records.some((r) => r.encroachment.length === 1 && r.openItems.some((i) => i.module === 'encroachment')));
  const first = built.records[0];
  assert.equal(first.geohazard.tier, 'amber'); assert.ok(first.drafts.some((d) => d.module === 'geohazard' && d.status === 'draft'));
  const draft = rec.drafts.find((d) => d.module === 'class_location');
  const wo = PLATFORM.workOrderFor(rec, draft, { by: 'A. Engineer', chosen: 'replace_pipe' }, { now: '2026-11-16T12:00:00.000Z' });
  assert.equal(wo.kind, 'replace_pipe'); assert.equal(wo.check.steps.length, rec.obligations.length); assert.equal(wo.check.status, 'needs_verification');
  assert.equal(PLATFORM.buildRecords(snap.segments, {}, {}, AS_OF).records[5].classLocation, null);   // no permit data: no class claim at all
});

test('exports: CSV for a maintenance system, GeoJSON for Esri, a PDF a person can open', () => {
  const built = PLATFORM.buildRecords(snap.segments, { permits }, {}, AS_OF), rec = built.records.find((r) => r.classLocation.status === 'change_possible');
  const wo = PLATFORM.workOrderFor(rec, rec.drafts[0], { by: 'A, "Eng"' }, { now: '2026-11-16T12:00:00.000Z' });
  const csv = EXPORT.workOrdersCsv([wo]).split('\r\n');
  assert.equal(csv[0], EXPORT.WO_COLUMNS.join(',')); assert.ok(csv[1].includes('"A, ""Eng"""'));
  const gj = EXPORT.segmentsGeoJSON(built.records, snap.segments);
  assert.equal(gj.features.length, 23); assert.equal(gj.features[0].geometry.type, 'LineString'); assert.ok('class_now' in gj.features[0].properties);
  const lines = EXPORT.draftFilingLines(rec, rec.decision, 'pressure_test');
  assert.ok(lines.some((l) => /NOT A FILING/.test(l.text || l)) && lines.some((l) => /placeholder/.test(l.text || l)) && lines.some((l) => /operator to complete/.test(l.text || l)));
  const pdf = EXPORT.pdf('Draft plan', [...lines, ...Array(80).fill('filler line (with parentheses) and a \\ backslash')]);
  assert.ok(pdf.startsWith('%PDF-1.4') && pdf.trimEnd().endsWith('%%EOF'));
  const xref = +pdf.match(/startxref\n(\d+)/)[1]; assert.equal(pdf.slice(xref, xref + 4), 'xref');
  const firstObj = +pdf.slice(xref).split('\n')[3].slice(0, 10); assert.equal(pdf.slice(firstObj, firstObj + 7), '1 0 obj');
  assert.ok((pdf.match(/\/Type \/Page /g) || []).length >= 2);
  assert.ok(/^[\x00-\x7f]*$/.test(pdf));
});

// ---- the generated workflows: run the real Code-node source with n8n's globals mocked
const wf = (f) => JSON.parse(fs.readFileSync(path.join(root, 'workflows', f), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function run(workflow, nodeName, { nodes = {}, input = [] } = {}) {
  const js = workflow.nodes.find((n) => n.name === nodeName).parameters.jsCode;
  const wrap = (arr) => arr.map((j) => ({ json: j }));
  const $ = (name) => { if (!(name in nodes)) throw new Error('mock has no node ' + name); const items = wrap(nodes[name]); return { all: () => items, first: () => items[0] }; };
  return new AsyncFunction('$', '$input', js)($, { all: () => wrap(input), first: () => wrap(input)[0] });
}
const segRows = line(4).map((s, i) => ({ segment_id: s.id, corridor_id: 'ab-strathcona-demo', segment_index: i, polygon_geometry_json: JSON.stringify({ features: [{ properties: { zone: 'centreline' }, geometry: { coordinates: s.centreline } }] }) }));
const GENERATED = ['W6 - Class location watch', 'W7 - Field feedback', 'W8 - Land obligations', 'W9 - Approval gate and evidence'].map((n) => `TerraCorridor ${n}.json`);

test('workflows are generated from src/, up to date, and import switched off', () => {
  const readAll = () => GENERATED.map((f) => fs.readFileSync(path.join(root, 'workflows', f), 'utf8'));
  const before = readAll();
  require('child_process').execFileSync(process.execPath, [path.join(root, 'scripts/make-platform-workflows.js')]);
  assert.deepEqual(readAll(), before, 'run node scripts/make-platform-workflows.js after changing src/');
  for (const t of before) assert.equal(JSON.parse(t).active, false);
});

test('W6 turns open-data permit rows into a class row per segment, and a failed download reads as unverified', async () => {
  const W6 = wf(GENERATED[0]);
  const cfg = (await run(W6, 'Class config'))[0].json;
  const plan = (await run(W6, 'Plan permit queries', { nodes: { 'Class config': [cfg], 'Get segments': segRows } }))[0].json;
  assert.match(plan.bpWhere, /units_added > 0 AND issue_date > '2019-12-31' AND latitude > '53\.3960'/);
  const bp = [{ row_id: 'BP-1', issue_date: '2026-06-01T00:00:00.000', units_added: '50', building_type: 'Apartment Condos (315)', latitude: String(53.4 + 0.5 * 0.009044), longitude: '-113.4005' },
    { row_id: 'BP-far', issue_date: '2026-06-01T00:00:00.000', units_added: '500', building_type: 'Apartment Condos (315)', latitude: '53.405', longitude: '-113.41' }];
  const nodes = { 'Plan permit queries': [plan], 'Get segments': segRows, 'Building permits (open data)': bp, 'Development permits (open data)': [], 'Get class baseline': [{ corridor_id: 'ab-strathcona-demo', bin: '2', roofs: '4', tall_roofs: '0' }] };
  const rows = (await run(W6, 'Assess class location', { nodes })).map((i) => i.json);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].status, 'change_committed'); assert.equal(rows[0].class_committed, 3); assert.equal(JSON.parse(rows[0].units_json).committed, 50);   // the permit 660 m away is outside the band
  assert.ok(rows[0].plan_due && JSON.parse(rows[0].decision_json).paths.length === 6);
  const failed = (await run(W6, 'Assess class location', { nodes: { ...nodes, 'Building permits (open data)': [{ error: 'timeout' }] } })).map((i) => i.json);
  assert.ok(failed.every((r) => r.status === 'unverified' && r.data_status === 'permit_download_failed'));
});

test('W7 refuses a bad finding and chains a good one; W9 refuses an anonymous decision', async () => {
  const W7 = wf(GENERATED[1]), W9 = wf(GENERATED[3]);
  assert.equal((await run(W7, 'Validate finding', { input: [{ body: { kind: 'dwelling_count', segment: 'S0', by: 'crew' } }] }))[0].json.ok, false);
  const ok = (await run(W7, 'Validate finding', { input: [{ body: { kind: 'dwelling_count', segment: 'S0', value: 12, by: 'crew 4', at: '2026-11-20T15:00:00Z' } }] }))[0].json;
  assert.equal(ok.ok, true);
  const row = (await run(W7, 'Chain finding', { nodes: { 'Validate finding': [ok], 'Get ledger': [] } }))[0].json;
  assert.equal(row.seq, '1'); assert.equal(row.prev, LEDGER.GENESIS);
  const action = { id: 'class_location:S0:compliance_plan:abc', module: 'class_location', segment: 'S0', kind: 'compliance_plan', inputsHash: 'abc' };
  const nodes = (body) => ({ 'POST /terracorridor/decide': [{ body }], 'Get ledger for decision': [{ seq: '1', entry_json: row.entry_json }] });
  const refused = (await run(W9, 'Decide and chain', { nodes: nodes({ action, decision: 'reject', by: 'A. Engineer' }) }))[0].json;
  assert.equal(refused.ok, false); assert.match(refused.error, /reason/);
  const done = (await run(W9, 'Decide and chain', { nodes: nodes({ action, decision: 'approve', by: 'A. Engineer', chosen: 'pressure_test' }) }))[0].json;
  assert.equal(done.seq, '2'); assert.equal(JSON.parse(done.entry_json).prev, row.hash);
  const feed = (await run(W9, 'Build platform feed', { nodes: { 'Get class rows': [], 'Get obligation rows': [], 'Get finding rows': [], 'Get ledger rows': [{ entry_json: row.entry_json }, { entry_json: done.entry_json }] } }))[0].json;
  assert.equal(feed.chain.ok, true); assert.equal(feed.ledger.length, 2);
  const broken = (await run(W9, 'Decide and chain', { nodes: { 'POST /terracorridor/decide': [{ body: { action, decision: 'approve', by: 'A' } }], 'Get ledger for decision': [{ entry_json: done.entry_json }] } }))[0].json;
  assert.match(broken.error, /chain is broken/);
});

test('W8 keeps only quoted obligations and checks a work order against them', async () => {
  const W8 = wf(GENERATED[2]);
  await assert.rejects(run(W8, 'Document to read'), /Paste a document/);
  const text = fs.readFileSync(path.join(root, 'data/obligations/commitment-table-format.txt'), 'utf8');
  const answer = 'Here you go:\n' + JSON.stringify([{ id: 'C-102', type: 'indigenous_monitoring', requirement: 'Indigenous monitor for clearing', triggers: ['vegetation_clearing'], kmFrom: 7.4, kmTo: 8.8, quote: 'retain an Indigenous monitor for all clearing activity' }, { id: 'C-X', type: 'payment', requirement: 'invented', triggers: ['any_entry'], kmFrom: 1, kmTo: 2, quote: 'this sentence is not in the document' }]);
  const saved = (await run(W8, 'Keep only quoted obligations', { nodes: { 'Document to read': [{ doc: 'format example', text }] }, input: [{ text: answer }] })).map((i) => i.json);
  assert.equal(saved.length, 1); assert.equal(saved[0].obligation_id, 'C-102'); assert.equal(saved[0].verified, 'false'); assert.equal(saved[0].rejected_in_run, '1');
  const obligationRows = [{ obligation_id: 'O-1', type: 'landowner_notice', requirement: 'Give 48 hours notice', triggers: 'any_entry', notice_hours: '48', km_from: '1.2', km_to: '1.8', agreement: 'A', verified: 'true' }];
  const check = (await run(W8, 'Check work order', { nodes: { 'POST /terracorridor/obligation-check': [{ body: { id: 'W1', segment: 'S1', kmFrom: 1, kind: 'inspection' } }], 'Get obligations': obligationRows, 'Get segments for check': segRows } }))[0].json;
  assert.equal(check.ok, true); assert.equal(check.status, 'clear_to_schedule'); assert.equal(check.noticeHours, 48);
});
