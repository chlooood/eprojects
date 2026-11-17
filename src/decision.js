// TerraCorridor decision module: what are the ways to deal with a class location change, what does
// each cost, how long does each take, and which ones still fit before the regulator's deadline?
// Every option is always listed, with the reason it is or is not available. No option is hidden
// and no single "answer" is given without the assumption it hinges on.
// COSTS ARE PLACEHOLDERS until interviews replace them (docs/CLASS_LOCATION.md). The output says so.
(function (root) {
  const SEG = root.TC_SEGMENTS || require('./segments.js');

  const DEFAULTS = {
    horizonYears: 10,
    // placeholder: true means "a team guess so the comparison runs", not a sourced figure.
    assumptions: {
      replaceCostPerM:     { value: 3500,   unit: '$ per m of pipe replaced', placeholder: true },
      replaceMonths:       { value: 12,     unit: 'months to permit and build', placeholder: true },
      pipeLeadMonths:      { value: 8,      unit: 'months to receive line pipe', placeholder: true },
      testFixedCost:       { value: 250000, unit: '$ per pressure test', placeholder: true },
      testCostPerM:        { value: 60,     unit: '$ per m tested', placeholder: true },
      testMonths:          { value: 5,      unit: 'months to plan and test', placeholder: true },
      reductionCostYr:     { value: 400000, unit: '$ a year of capacity lost at lower pressure', placeholder: true },
      reductionMonths:     { value: 1,      unit: 'months to lower pressure', placeholder: true },
      imInitialPerKm:      { value: 120000, unit: '$ per km of first-time integrity work', placeholder: true },
      imRecurringPerKmYr:  { value: 35000,  unit: '$ per km a year of added surveys and patrols', placeholder: true },
      imMonths:            { value: 12,     unit: 'months to complete the initial requirements', placeholder: true },
      assessCost:          { value: 150000, unit: '$ for an engineering assessment', placeholder: true },
      assessRecurringYr:   { value: 20000,  unit: '$ a year of added monitoring', placeholder: true },
      assessMonths:        { value: 5,      unit: 'months', placeholder: true },
      geohazardAddPerKmYr: { value: 15000,  unit: '$ per km a year where a geohazard must also be managed', placeholder: true },
    },
  };

  // The nine areas PHMSA lists for the integrity management alternative (2026 class change rule fact sheet).
  const IM_AREAS = ['gas quality', 'close interval surveys', 'patrolling', 'leak surveys', 'line markers', 'class location studies', 'shorted casings', 'exposed pipe and weld examinations', 'reassessments'];

  const val = (cfg, k) => { const a = cfg.assumptions[k]; return a && typeof a === 'object' ? a.value : a; };

  // change: { from, to, jurisdiction, lengthM, changeDate, due, asOf,
  //           pipe: { designClass } (optional), geohazard: { tier, hazard, why } (optional), obligations: [] (optional) }
  function comparePaths(change, cfg = DEFAULTS) {
    const km = (change.lengthM || 1000) / 1000, m = change.lengthM || 1000, H = cfg.horizonYears;
    const asOf = SEG.day(change.asOf || new Date());
    const start = change.changeDate && change.changeDate > asOf ? asOf : asOf;   // work can start now, before the change lands
    const geo = change.geohazard && ['amber', 'red', 'red-uncertain'].includes(change.geohazard.tier) ? change.geohazard : null;
    const digs = (change.obligations || []).filter((o) => (o.triggers || []).includes('ground_disturbance'));
    const paths = [];
    const add = (p) => {
      p.total = p.eligible ? Math.round(p.capex + p.recurringYr * H) : null;
      p.finishBy = p.eligible ? SEG.addMonths(start, Math.ceil(p.months)) : null;
      p.meetsDeadline = p.eligible && change.due ? p.finishBy <= change.due : null;
      paths.push(p);
    };

    const designKnown = change.pipe && change.pipe.designClass != null;
    add({ key: 'already_compliant', label: 'Show the pipe already meets the new class',
      eligible: designKnown ? change.pipe.designClass >= change.to : false,
      why: designKnown ? (change.pipe.designClass >= change.to ? `Pipe was designed for Class ${change.pipe.designClass}.` : `Pipe was designed for Class ${change.pipe.designClass}, below Class ${change.to}.`)
        : 'Not known: needs the design class from the operator\'s pipe records.',
      needs: designKnown ? [] : ['pipe design records'],
      capex: 0, recurringYr: 0, months: 1, groundDisturbance: false, conditions: ['File the primary assessment showing the existing design meets the new class.'] });

    add({ key: 'pressure_reduction', label: 'Lower the operating pressure', eligible: true, why: 'Always available. Costs capacity every year.',
      capex: 0, recurringYr: val(cfg, 'reductionCostYr'), months: val(cfg, 'reductionMonths'), groundDisturbance: false, needs: [], conditions: ['Confirm the reduced pressure meets the new class.'] });

    add({ key: 'pressure_test', label: 'Pressure test to confirm the operating pressure', eligible: true, why: 'Available where the pipe can pass a test at the level the new class needs.',
      capex: val(cfg, 'testFixedCost') + val(cfg, 'testCostPerM') * m, recurringYr: 0, months: val(cfg, 'testMonths'), groundDisturbance: true, needs: ['pipe grade, wall thickness and prior test records'],
      conditions: ['Line out of service during the test.', 'Test heads and water handling need ground access.'] });

    const lead = val(cfg, 'pipeLeadMonths'), build = val(cfg, 'replaceMonths');
    const replace = { key: 'replace_pipe', label: 'Replace the pipe', eligible: true, why: 'Always available. The most expensive and slowest path.',
      capex: val(cfg, 'replaceCostPerM') * m, recurringYr: 0, months: lead + build, groundDisturbance: true, needs: [],
      conditions: ['Line pipe has to be ordered before construction can be scheduled.'],
      materials: { leadMonths: lead, orderBy: change.due ? SEG.addMonths(change.due, -Math.ceil(lead + build)) : null } };
    if (replace.materials.orderBy) replace.materials.note = replace.materials.orderBy < asOf
      ? `To finish by ${change.due} the pipe had to be ordered by ${replace.materials.orderBy}. That date has passed, so this path needs an interim measure.`
      : `Order pipe by ${replace.materials.orderBy} to finish by ${change.due}.`;
    add(replace);

    const imOk = change.jurisdiction === 'US' && change.to === 3 && (change.from === 1 || change.from === 2);
    add({ key: 'im_alternative', label: 'Integrity management alternative, 49 CFR 192.611(a)(4)',
      eligible: imOk,
      why: change.jurisdiction !== 'US' ? 'United States rule. Not available under Canadian regulation.' : imOk ? 'Class 1 or 2 changing to Class 3, subject to the segment meeting the rule\'s eligibility criteria.' : 'Only for a change from Class 1 or 2 to Class 3.',
      capex: val(cfg, 'imInitialPerKm') * km, recurringYr: (val(cfg, 'imRecurringPerKmYr') + (geo ? val(cfg, 'geohazardAddPerKmYr') : 0)) * km, months: val(cfg, 'imMonths'), groundDisturbance: false,
      needs: ['confirmation that the segment is an "eligible Class 3 segment" under 49 CFR 192.3'],
      conditions: [`Initial and recurring requirements cover: ${IM_AREAS.join(', ')}.`, ...(geo ? [`This kilometre is flagged for ${geo.hazard || 'a geohazard'} (${geo.why || geo.tier}). The integrity program has to address it, and the geohazard record becomes part of the evidence.`] : [])] });

    add({ key: 'engineering_assessment', label: 'Engineering assessment in the proposed plan',
      eligible: change.jurisdiction !== 'US',
      why: change.jurisdiction === 'US' ? 'Canadian route. In the United States use the integrity management alternative or a special permit.' : 'The CER expects the plan to show the pipe is suitable for continued service at the new class. CSA Z662 sets what the assessment must cover (UNVERIFIED: standard is paywalled).',
      capex: val(cfg, 'assessCost'), recurringYr: val(cfg, 'assessRecurringYr') + (geo ? val(cfg, 'geohazardAddPerKmYr') * km : 0), months: val(cfg, 'assessMonths'), groundDisturbance: false,
      needs: ['pipe condition data: inspection results, coating, depth of cover'],
      conditions: ['If the assessment cannot be finished inside the six months, the plan gives its timeline and the interim measures.', ...(geo ? [`This kilometre is flagged for ${geo.hazard || 'a geohazard'} (${geo.why || geo.tier}); the assessment has to cover it.`] : [])] });

    // The join with land obligations: any path that breaks ground triggers them.
    for (const p of paths) {
      p.obligations = p.groundDisturbance ? digs.map((o) => ({ id: o.id, requirement: o.requirement, noticeHours: o.noticeHours || 0, verified: !!o.verified })) : [];
      if (p.obligations.length) p.conditions = [...p.conditions, `${p.obligations.length} land obligation${p.obligations.length === 1 ? '' : 's'} on this kilometre apply before ground is broken.`];
    }

    const rank = (list) => [...list].sort((a, b) => a.total - b.total);
    const open = paths.filter((p) => p.eligible);
    const inTime = open.filter((p) => p.meetsDeadline !== false);
    const pick = rank(inTime)[0] || rank(open)[0] || null;
    return {
      change: { from: change.from, to: change.to, jurisdiction: change.jurisdiction, due: change.due || null, km: Math.round(km * 100) / 100 },
      horizonYears: H,
      paths: paths.map((p) => ({ ...p, months: Math.ceil(p.months) })),
      lowestCost: pick ? { key: pick.key, label: pick.label, total: pick.total, meetsDeadline: pick.meetsDeadline } : null,
      needsInterim: pick ? pick.meetsDeadline === false : null,
      unknowns: [...new Set(paths.flatMap((p) => p.needs || []))],
      pricedWithPlaceholders: Object.values(cfg.assumptions).some((a) => a && a.placeholder),
    };
  }

  // Which assumption does the lowest-cost answer hinge on? Halve and double each one and see if the pick changes.
  function hingesOn(change, cfg = DEFAULTS) {
    const base = comparePaths(change, cfg).lowestCost;
    if (!base) return [];
    const out = [];
    for (const [k, a] of Object.entries(cfg.assumptions)) {
      for (const f of [0.5, 2]) {
        const c = JSON.parse(JSON.stringify(cfg)); c.assumptions[k].value = a.value * f;
        const pick = comparePaths(change, c).lowestCost;
        if (pick && pick.key !== base.key) { out.push({ assumption: k, unit: a.unit, at: a.value * f, flipsTo: pick.key, placeholder: !!a.placeholder }); break; }
      }
    }
    return out;
  }

  function mergeAssumptions(over) {
    const c = JSON.parse(JSON.stringify(DEFAULTS));
    for (const [k, v] of Object.entries(over || {})) {
      if (k === 'horizonYears') c.horizonYears = +v;
      else if (c.assumptions[k]) c.assumptions[k] = typeof v === 'object' ? { ...c.assumptions[k], ...v } : { ...c.assumptions[k], value: +v, placeholder: false };
    }
    return c;
  }

  // When to order pipe, from a forecast that gives a spread of change dates instead of one date.
  // samples: simulated change dates (decimal years) from the futures that changed; runs: how many futures in all.
  // The work has to be done by the change date plus the regulator's clock, so pipe must be ordered
  // (lead + build - clock) months before the change. Order now if the chance the change lands inside that window
  // is at least the threshold the operator sets. Also says the latest order date at that threshold.
  function orderSignal(samples, runs, o = {}) {
    const lead = o.leadMonths != null ? o.leadMonths : val(DEFAULTS, 'pipeLeadMonths'), build = o.buildMonths != null ? o.buildMonths : val(DEFAULTS, 'replaceMonths');
    const clock = o.clockMonths != null ? o.clockMonths : 6, threshold = o.threshold != null ? o.threshold : 0.5, now = o.now;
    const windowMonths = lead + build - clock, xs = [...(samples || [])].sort((a, b) => a - b), n = runs || xs.length || 1;
    const pBy = (t) => xs.filter((x) => x <= t).length / n;
    if (windowMonths <= 0) return { windowMonths, needed: false, orderNow: false, note: 'The regulator\'s clock is longer than the pipe lead time plus construction. Order after the change.' };
    const pWithin = pBy(now + windowMonths / 12), need = Math.ceil(threshold * n);
    const orderBy = xs.length >= need ? xs[need - 1] - windowMonths / 12 : null;
    return { windowMonths, threshold, pWithin: +pWithin.toFixed(3), orderNow: pWithin >= threshold, orderBy, needed: true,
      note: orderBy == null ? `Fewer than ${Math.round(threshold * 100)}% of futures change at all, so no order date.` : null };
  }

  const api = { DEFAULTS, IM_AREAS, comparePaths, hingesOn, mergeAssumptions, orderSignal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TC_DECISION = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
