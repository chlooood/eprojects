// TerraCorridor class location module (lead module).
// Counts dwellings in a sliding 1.6 km window, 200 m each side of the line, and says which segments
// are about to change class, when, and on what evidence. Building-count vendors see a house after it
// is built. This reads permits, so it sees it one construction season earlier, and development
// permits and plans earlier still.
// Rules decide. Nothing here is a probability. Missing data means "unverified", never "Class 1".
(function (root) {
  const SEG = root.TC_SEGMENTS || require('./segments.js');

  const DEFAULTS = {
    bandM: 200,        // each side of the centreline. US 49 CFR 192.5 uses 220 yards. CSA Z662's assessment area is paywalled: UNVERIFIED, confirm with the domain advisor.
    windowM: 1600,     // the sliding mile
    stepM: 200,        // how finely the window slides; the same grid the permit cache is binned on
    thresholds: { class2: 11, class3: 46 },   // dwelling units in the window: more than 10 is Class 2, 46 or more is Class 3 (49 CFR 192.5; CSA Z662 UNVERIFIED)
    jurisdiction: 'CA',
    clocks: {
      CA: { months: 6, basis: 'CER Onshore Pipeline Regulations s.42 and Filing Manual Guide E: the proposed plan is filed within six months after the change.' },
      US: { months: 24, floor: '2028-03-16', basis: '49 CFR 192.611: 24 months after the change. Under the 2026 rule the integrity management alternative must be complete by 16 March 2028 or 24 months after the change, whichever is later.' },
    },
    // Assumption: months from permit issue to an occupied dwelling, by City of Edmonton building type code.
    lagMonths: { 110: 8, 210: 8, 215: 10, 330: 12, 335: 12, 315: 20, cluster: 18, backyard: 8, default: 9 },
    devToOccupiedMonths: 18,   // assumption: a development permit with no building permit yet
    roofsPerDwelling: 1,       // assumption: one roof of 60 m2 or more counts as one dwelling until a crew counts
    evidenceTop: 6,
  };

  const quarterMid = (q) => { const y = q.slice(0, 4), n = +q.slice(5); return `${y}-${String(n * 3 - 1).padStart(2, '0')}-15`; };
  const lagFor = (cfg, code) => cfg.lagMonths[code] != null ? cfg.lagMonths[code] : cfg.lagMonths.default;
  const parseCells = (s) => (s ? String(s).split(/[;,](?=\d+[:,])|;/).filter(Boolean) : []);

  // Turns a permit cache (data/cache/permits/*.json) into dated events along the line.
  // Also accepts raw point permits: { id, issued, units, type, lon, lat } located with the segment index.
  function normalize(data, index, cfg = DEFAULTS) {
    const binM = (data && data.binM) || cfg.stepM;
    const mid = (bin) => (bin + 0.5) * binM;
    const events = [];
    const add = (src, kind) => {
      if (!src) return;
      for (const r of src.large || []) {
        const [id, issued, units, code, chainageM, note] = r;
        const lag = kind === 'development_permit' ? cfg.devToOccupiedMonths : lagFor(cfg, code);
        events.push({ id, kind, issued, units: +units, type: String(code), chainageM: +chainageM, occupied: SEG.addMonths(issued, lag), permits: 1, note: note || null, dataset: src.dataset });
      }
      for (const c of String(src.cells || '').split(';').filter(Boolean)) {
        const [bin, q, n, units] = c.split(',');
        const issued = quarterMid(q);
        const lag = kind === 'development_permit' ? cfg.devToOccupiedMonths : cfg.lagMonths.default;
        events.push({ id: `${src.dataset}:bin${bin}:${q}`, kind, issued, units: +units, type: 'grouped', chainageM: mid(+bin), occupied: SEG.addMonths(issued, lag), permits: +n, note: `${n} permits in ${q}`, dataset: src.dataset });
      }
      for (const p of src.points || []) {
        const at = SEG.locate(index, [p.lon, p.lat]);
        if (at.offsetM > cfg.bandM) continue;
        const lag = kind === 'development_permit' ? cfg.devToOccupiedMonths : lagFor(cfg, p.type);
        events.push({ id: p.id, kind, issued: SEG.day(p.issued), units: +p.units, type: String(p.type || ''), chainageM: at.chainageM, offsetM: Math.round(at.offsetM), occupied: SEG.addMonths(SEG.day(p.issued), lag), permits: 1, note: p.note || null, dataset: src.dataset });
      }
    };
    add(data && data.buildingPermits, 'building_permit');
    add(data && data.developmentPermits, 'development_permit');
    const roofs = data && data.rooflines;
    const bins = {}, tall = {};
    if (roofs) {
      for (const c of String(roofs.cells || '').split(',').filter(Boolean)) { const [k, v] = c.split(':'); bins[k] = +v; }
      for (const c of String(roofs.tallCells || '').split(',').filter(Boolean)) { const [k, v] = c.split(':'); tall[k] = +v; }
    }
    return {
      binM,
      baseline: roofs ? { date: roofs.asOf, bins, tall, dataset: roofs.dataset, name: roofs.name } : null,
      events: events.sort((a, b) => a.issued.localeCompare(b.issued)),
      devSince: (data && data.developmentPermits && data.developmentPermits.since) || null,
      plans: (data && data.plans && data.plans.rows) || [],
      fetchedAt: (data && data.fetchedAt) || null,
      municipality: (data && data.municipality) || null,
    };
  }

  const classOf = (units, cfg = DEFAULTS) => (units >= cfg.thresholds.class3 ? 3 : units >= cfg.thresholds.class2 ? 2 : 1);
  const nextThreshold = (units, cfg = DEFAULTS) => (units < cfg.thresholds.class2 ? cfg.thresholds.class2 : units < cfg.thresholds.class3 ? cfg.thresholds.class3 : null);

  // Dwelling units in one window [fromM, fromM + windowM) as of a date.
  //   existing:  roofs counted in the baseline survey, plus permitted units whose assumed occupancy date has passed
  //   committed: building permits issued but not yet occupied
  //   possible:  development permits not yet matched by building permits in the same window
  function windowCount(state, fromM, asOf, cfg = DEFAULTS) {
    const toM = fromM + cfg.windowM;
    const inWin = (e) => e.chainageM >= fromM && e.chainageM < toM;
    let roofs = 0, tall = 0;
    if (state.baseline) for (const [k, v] of Object.entries(state.baseline.bins)) { const c = (+k + 0.5) * state.binM; if (c >= fromM && c < toM) { roofs += v; tall += state.baseline.tall[k] || 0; } }
    const base = state.baseline ? state.baseline.date : '0000-00-00';
    const bp = state.events.filter((e) => e.kind === 'building_permit' && inWin(e) && e.issued <= asOf && e.issued > base);
    const built = bp.filter((e) => e.occupied <= asOf), pending = bp.filter((e) => e.occupied > asOf);
    const sum = (xs) => xs.reduce((a, e) => a + e.units, 0);
    const dev = state.events.filter((e) => e.kind === 'development_permit' && inWin(e) && e.issued <= asOf);
    const bpSinceDev = state.devSince ? sum(bp.filter((e) => e.issued >= state.devSince)) : 0;
    const possible = Math.max(0, sum(dev) - bpSinceDev);
    return { fromM, toM, existing: Math.round(roofs * cfg.roofsPerDwelling) + sum(built), roofs, built: sum(built), committed: sum(pending), possible, tallRoofs: tall, pending, dev };
  }

  // The class location picture for one segment: the worst 1.6 km window that touches it.
  function assessSegment(range, state, cfg = DEFAULTS, asOf) {
    asOf = SEG.day(asOf || new Date());
    let best = null;
    const first = Math.max(0, Math.floor((range.fromM - cfg.windowM) / cfg.stepM) * cfg.stepM + cfg.stepM);
    for (let s = first; s < range.toM; s += cfg.stepM) {
      const w = windowCount(state, s, asOf, cfg);
      const total = w.existing + w.committed + w.possible;
      if (!best || total > best.total || (total === best.total && w.existing > best.w.existing)) best = { w, total };
    }
    const w = best.w;
    const hasBaseline = !!state.baseline;
    const now = classOf(w.existing, cfg), committed = classOf(w.existing + w.committed, cfg), possible = classOf(w.existing + w.committed + w.possible, cfg);
    // When do the committed units push the count over each line? Walk them in occupancy order.
    const crossings = [];
    let run = w.existing;
    for (const e of [...w.pending].sort((a, b) => a.occupied.localeCompare(b.occupied))) {
      const before = classOf(run, cfg); run += e.units; const after = classOf(run, cfg);
      if (after > before) crossings.push({ from: before, to: after, expected: e.occupied, tippingPermit: e.id });
    }
    // Did it already change inside the last year? Then the regulator's clock may be running now.
    const yearAgo = windowCount(state, w.fromM, SEG.addMonths(asOf, -12), cfg);
    const classYearAgo = classOf(yearAgo.existing, cfg);
    let changedOn = null;
    if (now > classYearAgo) {
      let c = yearAgo.existing;
      const base = state.baseline ? state.baseline.date : '0000-00-00';
      const done = state.events.filter((e) => e.kind === 'building_permit' && e.chainageM >= w.fromM && e.chainageM < w.toM && e.issued > base && e.occupied > SEG.addMonths(asOf, -12) && e.occupied <= asOf)
        .sort((a, b) => a.occupied.localeCompare(b.occupied));
      for (const e of done) { c += e.units; if (classOf(c, cfg) > classYearAgo) { changedOn = e.occupied; break; } }
    }
    const status = !hasBaseline && now === 1 && committed === 1 && possible === 1 ? 'unverified'
      : changedOn ? 'changed' : committed > now ? 'change_committed' : possible > now ? 'change_possible' : 'no_change';
    const change = status === 'changed' ? { from: classYearAgo, to: now, date: changedOn, basis: 'estimated occupancy of permitted units' }
      : status === 'change_committed' ? { from: now, to: committed, date: crossings[0].expected, basis: 'issued building permits', steps: crossings }
      : status === 'change_possible' ? { from: now, to: possible, date: null, basis: 'development permits not yet matched by building permits' } : null;
    const clockRule = cfg.clocks[cfg.jurisdiction] || cfg.clocks.CA;
    let clock = null;
    if (change && change.date) {
      let due = SEG.addMonths(change.date, clockRule.months);
      if (clockRule.floor && due < clockRule.floor) due = clockRule.floor;
      clock = { jurisdiction: cfg.jurisdiction, changeDate: change.date, due, monthsLeft: SEG.monthsBetween(asOf, due), running: change.date <= asOf, basis: clockRule.basis };
    }
    const next = nextThreshold(w.existing, cfg);
    const evidence = [...w.pending, ...(status === 'change_possible' || w.possible ? w.dev : [])]
      .sort((a, b) => b.units - a.units || b.issued.localeCompare(a.issued)).slice(0, cfg.evidenceTop)
      .map((e) => ({ id: e.id, kind: e.kind, issued: e.issued, units: e.units, expectedOccupied: e.occupied, km: Math.round(e.chainageM / 100) / 10, note: e.note, dataset: e.dataset }));
    const plans = state.plans.filter((p) => p.kmFrom * 1000 < w.toM && p.kmTo * 1000 + 1 > w.fromM).map((p) => ({ name: p.name, type: p.type, bylaw: p.bylaw, pdf: p.pdf }));
    return {
      asOf, status, jurisdiction: cfg.jurisdiction,
      window: { kmFrom: w.fromM / 1000, kmTo: w.toM / 1000 },
      units: { existing: w.existing, roofsAtBaseline: w.roofs, builtSinceBaseline: w.built, committed: w.committed, possible: w.possible },
      class: { now, committed, possible, yearAgo: classYearAgo, isLowerBound: !hasBaseline },
      headroom: next == null ? null : next - w.existing,
      change, clock, evidence, plans,
      class4: { assessed: false, tallRoofs: w.tallRoofs, note: 'Class 4 depends on buildings of four or more storeys. Not assessed; tall roofs are listed as a prompt only.' },
      basis: hasBaseline ? `${state.baseline.name}, plus building permits issued since` : 'building permits only: a lower bound, no baseline count loaded',
    };
  }

  function forecast(segments, data, cfg = DEFAULTS, asOf) {
    const index = SEG.buildIndex(segments), state = normalize(data, index, cfg);
    const bySegment = {};
    for (const r of index.ranges) bySegment[r.id] = assessSegment(r, state, cfg, asOf);
    const all = Object.values(bySegment), n = (s) => all.filter((a) => a.status === s).length;
    return { asOf: SEG.day(asOf || new Date()), jurisdiction: cfg.jurisdiction, municipality: state.municipality, fetchedAt: state.fetchedAt, bySegment,
      summary: { segments: all.length, changed: n('changed'), changeCommitted: n('change_committed'), changePossible: n('change_possible'), noChange: n('no_change'), unverified: n('unverified'),
        class3Now: all.filter((a) => a.class.now === 3).length, class2Now: all.filter((a) => a.class.now === 2).length } };
  }

  // Replay: walk forward a quarter at a time, using only what was on file by each date.
  // "flagged" is the first date the issued permits already added up to a higher class.
  // "changed" is the first date the estimated occupied count reached it.
  // The gap between them rests on the construction-lag assumption until multi-date building counts replace it.
  function backtest(segments, data, cfg = DEFAULTS, opts = {}) {
    const index = SEG.buildIndex(segments), state = normalize(data, index, cfg);
    const from = opts.from || (state.baseline ? SEG.addMonths(state.baseline.date, 3) : '2015-03-31'), to = SEG.day(opts.to || new Date());
    const rows = [];
    for (const r of index.ranges) {
      const flagged = {}, changed = {};
      let start = null;
      for (let d = from; d <= to; d = SEG.addMonths(d, 3)) {
        const a = assessSegment(r, state, cfg, d);
        if (start == null) start = a.class.now;
        for (let c = start + 1; c <= 3; c++) {
          if (a.class.committed >= c && !flagged[c]) flagged[c] = d;
          if (a.class.now >= c && !changed[c]) changed[c] = d;
        }
      }
      for (let c = (start || 1) + 1; c <= 3; c++) {
        if (!flagged[c]) continue;
        rows.push({ segment: r.id, kmFrom: r.kmFrom, toClass: c, startClass: start, flagged: flagged[c], changed: changed[c] || null,
          leadMonths: changed[c] ? Math.max(0, SEG.monthsBetween(flagged[c], changed[c])) : null });
      }
    }
    const done = rows.filter((x) => x.changed), leads = done.map((x) => x.leadMonths).sort((a, b) => a - b);
    return { from, to, rows, changes: done.length, flaggedAhead: done.filter((x) => x.leadMonths > 0).length, pending: rows.length - done.length,
      medianLeadMonths: leads.length ? leads[Math.floor(leads.length / 2)] : null,
      caveat: 'Change dates are estimated from an assumed construction lag after permit issue, not observed. Replace them with dated building counts before quoting the lead time.' };
  }

  const api = { DEFAULTS, normalize, classOf, nextThreshold, windowCount, assessSegment, forecast, backtest, quarterMid };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TC_CLASS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
