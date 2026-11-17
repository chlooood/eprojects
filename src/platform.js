// TerraCorridor platform: the join. One record per kilometre that carries class location, geohazard,
// land obligations and encroachment together, with one approval trail. Each incumbent owns one of
// these. The product is that they sit on the same kilometre and inform each other:
//   - a geohazard flag becomes a condition on the integrity path of a class decision
//   - a class fix that needs a dig is checked against the land obligations on that kilometre
//   - a crew walking for one module writes findings the others read
(function (root) {
  const SEG = root.TC_SEGMENTS || require('./segments.js');
  const CLASS = root.TC_CLASS || require('./classlocation.js');
  const DECISION = root.TC_DECISION || require('./decision.js');
  const OBL = root.TC_OBLIGATIONS || require('./obligations.js');
  const FEEDBACK = root.TC_FEEDBACK || require('./feedback.js');
  const LEDGER = root.TC_LEDGER || require('./ledger.js');

  const DEFAULTS = { prescribedM: 30, horizon: 'y10', dueDays: { P1: 14, P2: 60, P3: 180 } };
  const HAZ = { ground: 'ground failure', crossing: 'river crossing', wildfire: 'wildfire weather', drought: 'drought' };
  const FLAGGED = ['amber', 'red', 'red-uncertain'];

  // Geohazard part of the record, read from the existing long-range engine output (src/engine.js, W2).
  function geohazardOf(seg, horizon) {
    const r = seg.risk && seg.risk[horizon];
    if (!r || r.score == null) return { tier: 'unverified', score: null, hazard: null, why: 'No geohazard score on file.' };
    const h = r.hazards && r.hazard && r.hazards[r.hazard];
    return { tier: (seg.override && seg.override.tier) || r.tier, score: r.score, hazard: HAZ[r.hazard] || r.hazard || 'ground failure', why: h ? h.why : (r.drivers && r.drivers[0] ? r.drivers[0].label : null), agreement: r.agreement == null ? null : r.agreement };
  }

  // New digging or structures reported near the line. Inside the prescribed area it is a flag for the
  // right-of-way team; outside it but inside the class band it is evidence for class location.
  function screenEncroachment(events, index, cfg = DEFAULTS, bandM = 200) {
    const flags = {}, classEvidence = {};
    for (const e of events || []) {
      if (e.lon == null || e.lat == null) continue;
      const at = SEG.locate(index, [e.lon, e.lat]), id = SEG.segmentAt(index, at.chainageM);
      if (!id) continue;
      const row = { id: e.id, kind: e.kind || 'ground_disturbance', offsetM: Math.round(at.offsetM), km: Math.round(at.chainageM / 100) / 10, observedAt: e.observedAt || null, source: e.source || null, note: e.note || null };
      if (at.offsetM <= cfg.prescribedM) (flags[id] = flags[id] || []).push(row);
      else if (at.offsetM <= bandM && row.kind === 'structure') (classEvidence[id] = classEvidence[id] || []).push(row);
    }
    return { flags, classEvidence };
  }

  function decisionFor(rec, classCfg, decisionCfg, asOf) {
    const c = rec.classLocation;
    if (!c || !c.change) return null;
    const change = { from: c.change.from, to: c.change.to, jurisdiction: c.jurisdiction, lengthM: classCfg.windowM, changeDate: c.change.date, due: c.clock ? c.clock.due : null, asOf,
      pipe: rec.pipe || null, geohazard: rec.geohazard, obligations: rec.obligations };
    return { ...DECISION.comparePaths(change, decisionCfg), hingesOn: DECISION.hingesOn(change, decisionCfg) };
  }

  // What each module is proposing for this kilometre. All drafts: nothing happens until a person decides.
  function draftsFor(rec, asOf) {
    const out = [], c = rec.classLocation, at = asOf + 'T00:00:00.000Z';
    if (c && c.change) out.push(LEDGER.draft('class_location', rec.id, c.status === 'change_possible' ? 'watch' : 'compliance_plan', { from: c.change.from, to: c.change.to, date: c.change.date, due: c.clock ? c.clock.due : null, units: c.units, evidence: c.evidence.map((e) => e.id) }, { at }));
    if (FLAGGED.includes(rec.geohazard.tier)) out.push(LEDGER.draft('geohazard', rec.id, 'inspection', { tier: rec.geohazard.tier, score: rec.geohazard.score, hazard: rec.geohazard.hazard }, { at }));
    const unv = (rec.obligations || []).filter((o) => !o.verified);
    if (unv.length) out.push(LEDGER.draft('land_obligations', rec.id, 'verify_obligations', { ids: unv.map((o) => o.id) }, { at }));
    for (const f of rec.encroachment || []) out.push(LEDGER.draft('encroachment', rec.id, 'row_review', { flag: f.id, kind: f.kind, offsetM: f.offsetM == null ? null : f.offsetM }, { at }));
    return out;
  }

  function openItems(rec) {
    const items = [], c = rec.classLocation;
    if (c && c.status === 'changed') items.push({ module: 'class_location', level: 1, text: `Class ${c.change.from} to ${c.change.to} on about ${c.change.date}. Plan due ${c.clock ? c.clock.due : 'date unknown'}.` });
    if (c && c.status === 'change_committed') items.push({ module: 'class_location', level: 1, text: `Permits already issued take this to Class ${c.change.to} around ${c.change.date}.` });
    if (c && c.status === 'change_possible') items.push({ module: 'class_location', level: 2, text: `Development permits could take this to Class ${c.change.to}. ${c.headroom} more dwelling${c.headroom === 1 ? '' : 's'} would reach the next class.` });
    if (c && c.status === 'unverified') items.push({ module: 'class_location', level: 3, text: 'No dwelling data for this kilometre.' });
    if (FLAGGED.includes(rec.geohazard.tier)) items.push({ module: 'geohazard', level: rec.geohazard.tier === 'amber' ? 2 : 1, text: `${rec.geohazard.hazard}: ${rec.geohazard.why || rec.geohazard.tier}` });
    const unv = (rec.obligations || []).filter((o) => !o.verified).length;
    if (unv) items.push({ module: 'land_obligations', level: 2, text: `${unv} obligation${unv === 1 ? '' : 's'} not yet verified by a person.` });
    for (const f of rec.encroachment || []) items.push({ module: 'encroachment', level: 1, text: `${f.kind.replace(/_/g, ' ')} ${f.offsetM == null ? 'inside' : f.offsetM + ' m from the line, inside'} the prescribed area.` });
    return items.sort((a, b) => a.level - b.level);
  }

  // After a crew counts dwellings, restate the class picture from the counted number.
  function restate(c) {
    if (!c || !c.fieldCounted) return;
    if (c.class.committed > c.class.now) { c.status = 'change_committed'; c.change = { ...(c.change || {}), from: c.class.now, to: c.class.committed, basis: 'issued building permits, on a count made on site' }; }
    else if (c.class.possible > c.class.now) { c.status = 'change_possible'; c.change = { from: c.class.now, to: c.class.possible, date: null, basis: 'development permits, on a count made on site' }; c.clock = null; }
    else { c.status = 'no_change'; c.change = null; c.clock = null; }
  }

  // data: { permits, obligations: [], encroachmentEvents: [], findings: [], pipe: { [segmentId]: { designClass } } }
  function buildRecords(segments, data = {}, cfg = {}, asOf) {
    asOf = SEG.day(asOf || new Date());
    const P = { ...DEFAULTS, ...(cfg.platform || {}) }, classCfg = { ...CLASS.DEFAULTS, ...(cfg.classLocation || {}) }, decisionCfg = cfg.decision || DECISION.DEFAULTS;
    const index = SEG.buildIndex(segments);
    const cls = data.permits ? CLASS.forecast(segments, data.permits, classCfg, asOf) : null;
    const pinned = OBL.pinToSegments(data.obligations || [], index);
    const enc = screenEncroachment(data.encroachmentEvents, index, P, classCfg.bandM);
    const before = segments.filter((s) => SEG.rangeOf(index, s.id)).map((s) => ({
      id: s.id, kmFrom: s.kmFrom, kmTo: s.kmTo, mid: s.centreline[Math.floor(s.centreline.length / 2)],
      geohazard: geohazardOf(s, P.horizon),
      classLocation: cls ? cls.bySegment[s.id] : null,
      obligations: pinned[s.id] || [],
      encroachment: enc.flags[s.id] || [],
      nearbyStructures: enc.classEvidence[s.id] || [],
      pipe: (data.pipe && data.pipe[s.id]) || null,
      field: [],
    }));
    const records = before.map((r) => {
      const rec = FEEDBACK.apply(r, data.findings || [], classCfg);
      restate(rec.classLocation);
      rec.decision = decisionFor(rec, classCfg, decisionCfg, asOf);
      rec.drafts = draftsFor(rec, asOf);
      rec.openItems = openItems(rec);
      return rec;
    });
    const labels = FEEDBACK.outcomeLabels(before, data.findings || []);
    return { asOf, jurisdiction: classCfg.jurisdiction, records, classSummary: cls ? cls.summary : null, labels, scoreboard: FEEDBACK.scoreboard(labels),
      coverage: { classLocation: !!data.permits, obligations: (data.obligations || []).length, encroachmentFeed: Array.isArray(data.encroachmentEvents), findings: (data.findings || []).length } };
  }

  // A work order for an approved draft, already checked against the land obligations on that kilometre.
  function workOrderFor(rec, draft, decision, opts = {}) {
    const now = opts.now || new Date().toISOString();
    const kind = draft.module === 'class_location' ? (decision.chosen && ['replace_pipe', 'pressure_test'].includes(decision.chosen) ? decision.chosen : 'walkdown') : draft.module === 'encroachment' ? 'inspection' : 'inspection';
    const priority = draft.module === 'encroachment' || (rec.classLocation && rec.classLocation.status === 'changed' && draft.module === 'class_location') || rec.geohazard.tier.startsWith('red') ? 'P1' : 'P2';
    const due = new Date(new Date(now).getTime() + DEFAULTS.dueDays[priority] * 86400000).toISOString().slice(0, 10);
    const reason = draft.module === 'class_location' ? `Class location: confirm the dwelling count for km ${rec.classLocation.window.kmFrom} to ${rec.classLocation.window.kmTo}` + (decision.chosen ? `; path chosen: ${decision.chosen.replace(/_/g, ' ')}` : '')
      : draft.module === 'geohazard' ? `Geohazard: ${rec.geohazard.hazard}. ${rec.geohazard.why || ''}` : draft.module === 'encroachment' ? 'Activity inside the prescribed area' : 'Verify land obligations with the land team';
    const wo = { id: `WO-${rec.id}-${draft.module}-${now.slice(0, 10).replace(/-/g, '')}`, segment: rec.id, kmFrom: rec.kmFrom, kmTo: rec.kmTo, module: draft.module, kind, priority, dueBy: due, reason, status: 'approved', approvedBy: decision.by, approvedAt: decision.at || now, plannedStart: opts.plannedStart || null, lon: rec.mid ? rec.mid[0] : null, lat: rec.mid ? rec.mid[1] : null };
    wo.check = OBL.checkWorkOrder(wo, rec.obligations, { now });
    return wo;
  }

  const api = { DEFAULTS, geohazardOf, screenEncroachment, decisionFor, draftsFor, openItems, buildRecords, workOrderFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TC_PLATFORM = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
