// TerraCorridor field feedback (W7). Built first because every module depends on it.
// A crew that walks a kilometre for one reason sees things that matter to the others. Each finding
// is written back to the segment record, and each one is paired with what the system had said
// beforehand. Those pairs are the dataset nobody else has.
(function (root) {
  const KINDS = {
    dwelling_count:      { module: 'class_location',   needsValue: true,  label: 'Dwellings counted in the assessment window' },
    new_structure:       { module: 'class_location',   needsValue: false, label: 'New building or foundation seen' },
    ground_movement:     { module: 'geohazard',        needsValue: false, label: 'Ground movement, erosion or exposed pipe' },
    no_hazard_found:     { module: 'geohazard',        needsValue: false, label: 'Walked and found nothing' },
    obligation_met:      { module: 'land_obligations', needsValue: false, label: 'Obligation carried out' },
    obligation_missed:   { module: 'land_obligations', needsValue: false, label: 'Obligation missed or disputed' },
    unauthorized_work:   { module: 'encroachment',     needsValue: false, label: 'Digging or a structure inside the prescribed area' },
  };
  // A finding for one module also informs these.
  const ALSO = { new_structure: ['encroachment'], unauthorized_work: ['class_location'], ground_movement: ['land_obligations'] };

  function normalize(raw) {
    const k = KINDS[raw.kind], problems = [];
    if (!k) problems.push('unknown kind of finding');
    if (!raw.segment) problems.push('no segment');
    if (!raw.by) problems.push('no name');
    if (k && k.needsValue && (raw.value == null || raw.value === '' || Number.isNaN(+raw.value) || +raw.value < 0)) problems.push('needs a number');
    const at = raw.at || new Date().toISOString();
    return { finding: { id: raw.id || `F-${raw.segment}-${at.replace(/\D/g, '').slice(0, 14)}`, segment: raw.segment, kind: raw.kind, module: k ? k.module : null, also: ALSO[raw.kind] || [],
      value: raw.value == null || raw.value === '' ? null : +raw.value, note: raw.note || null, withinPrescribedArea: raw.withinPrescribedArea === true, workOrder: raw.workOrder || null, by: raw.by || null, at }, problems };
  }

  // What the system believed about this kilometre before the crew went, in the same terms as the finding.
  function predictionFor(record, kind) {
    const c = record.classLocation, g = record.geohazard;
    if (kind === 'dwelling_count') return c ? { value: c.units.existing, text: `${c.units.existing} dwellings estimated` } : null;
    if (kind === 'new_structure') return c ? { value: c.units.committed + c.units.possible > 0, text: `${c.units.committed + c.units.possible} units permitted but not yet counted` } : null;
    if (kind === 'ground_movement' || kind === 'no_hazard_found') return g ? { value: ['amber', 'red', 'red-uncertain'].includes(g.tier), text: `${g.tier} for ${g.hazard || 'ground failure'}` } : null;
    if (kind === 'unauthorized_work') return { value: (record.encroachment || []).length > 0, text: `${(record.encroachment || []).length} flags on file` };
    return null;
  }

  // Writes findings into a copy of the record. A counted number replaces an estimate and says so.
  function apply(record, findings, classCfg) {
    const r = JSON.parse(JSON.stringify(record));
    r.field = r.field || [];
    const mine = (findings || []).filter((f) => f.segment === r.id).sort((a, b) => a.at.localeCompare(b.at));
    for (const f of mine) {
      r.field.push({ id: f.id, kind: f.kind, module: f.module, also: f.also, value: f.value, note: f.note, by: f.by, at: f.at });
      if (f.kind === 'dwelling_count' && r.classLocation) {
        const c = r.classLocation, t = (classCfg && classCfg.thresholds) || { class2: 11, class3: 46 };
        const cls = (u) => (u >= t.class3 ? 3 : u >= t.class2 ? 2 : 1);
        c.units.estimatedBeforeCount = c.units.existing; c.units.existing = f.value;
        c.class.now = cls(f.value); c.class.committed = cls(f.value + c.units.committed); c.class.possible = cls(f.value + c.units.committed + c.units.possible);
        c.class.isLowerBound = false;
        c.basis = `counted on site by ${f.by} on ${f.at.slice(0, 10)}`;
        c.fieldCounted = true;
      }
      if (f.kind === 'new_structure' && f.withinPrescribedArea) (r.encroachment = r.encroachment || []).push({ id: f.id, kind: 'structure', source: 'field finding', observedAt: f.at, note: f.note });
      if (f.kind === 'unauthorized_work') (r.encroachment = r.encroachment || []).push({ id: f.id, kind: 'ground_disturbance', source: 'field finding', observedAt: f.at, note: f.note });
      if ((f.kind === 'ground_movement' || f.kind === 'no_hazard_found') && r.geohazard) (r.geohazard.fieldEvidence = r.geohazard.fieldEvidence || []).push({ id: f.id, confirmed: f.kind === 'ground_movement', note: f.note, by: f.by, at: f.at });
    }
    return r;
  }

  // One row per finding: what was predicted, what was seen. This table only exists because someone used the tool.
  function outcomeLabels(recordsBefore, findings) {
    const byId = Object.fromEntries((recordsBefore || []).map((r) => [r.id, r]));
    return (findings || []).map((f) => {
      const rec = byId[f.segment], p = rec ? predictionFor(rec, f.kind) : null;
      let agreed = null, error = null;
      if (p && f.kind === 'dwelling_count') { error = f.value - p.value; agreed = Math.abs(error) <= Math.max(2, 0.1 * f.value); }
      else if (p && f.kind === 'ground_movement') agreed = p.value === true;
      else if (p && f.kind === 'no_hazard_found') agreed = p.value === false;
      else if (p && (f.kind === 'new_structure' || f.kind === 'unauthorized_work')) agreed = p.value === true;
      return { finding: f.id, segment: f.segment, module: f.module, kind: f.kind, predicted: p ? p.text : null, observed: f.value != null ? f.value : (KINDS[f.kind] || {}).label, agreed, error, at: f.at, by: f.by };
    });
  }

  // Plain counts per module. No probabilities: there are too few rows to claim one.
  function scoreboard(labels) {
    const out = {};
    for (const l of labels || []) {
      const m = out[l.module] || (out[l.module] = { findings: 0, comparable: 0, agreed: 0 });
      m.findings++; if (l.agreed != null) { m.comparable++; if (l.agreed) m.agreed++; }
    }
    return out;
  }

  const api = { KINDS, ALSO, normalize, predictionFor, apply, outcomeLabels, scoreboard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TC_FEEDBACK = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
