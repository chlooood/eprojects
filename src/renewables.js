// TerraCorridor renewable-energy screening assessor. Pure JS, runs in the browser and in Node.
// Separate from pipeline risk (src/engine.js): it reads no risk score, tier, threshold or work order.
//
// Rules that keep it honest:
//  - Every factor is a linear ramp between two stated values, so a score can be checked by hand.
//  - A required input that is missing makes the candidate "incomplete": no ranked score, and the
//    missing factor is never scored as 0 cost or as best case.
//  - Land rights, interconnection capacity and permitting are never assessed here, so nothing is
//    ever labelled "feasible". The best status is a strong screening result with open gates.
//  - Capacity and money are scenarios from editable assumptions, not predictions.
(function (root) {
  const ramp = (v, lo, hi) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const round = (v, n = 1) => (num(v) ? Math.round(v * 10 ** n) / 10 ** n : null);

  const FACTORS = {
    solar: [
      { key: 'resource', label: 'Solar resource', weight: 0.35, unit: 'kWh/kWp/yr', lo: 900, hi: 1600, read: (c) => c.resource && c.resource.pvout, source: 'gsa',
        why: 'Modelled PV yield (Global Solar Atlas PVOUT). 900 scores 0, 1600 scores 100.' },
      { key: 'terrain', label: 'Terrain (median slope)', weight: 0.15, unit: '%', lo: 15, hi: 3, read: (c) => c.land && c.land.slopeMedianPct, source: 'dem',
        why: 'Median slope from Copernicus GLO-30. 3% or flatter scores 100, 15% or steeper scores 0.' },
      { key: 'area', label: 'Usable area', weight: 0.25, unit: 'ha', lo: 0, hi: 10, read: (c) => c.land && c.land.usableHa, source: 'worldcover',
        why: 'Open land cover, slope at or below the limit, outside protected areas. 10 ha or more scores 100.' },
      { key: 'grid', label: 'Distance to mapped substation', weight: 0.25, unit: 'km', lo: 15, hi: 1, read: gridKm, source: 'canvec',
        why: 'Nearest CanVec transformer station. 1 km or closer scores 100, 15 km or farther scores 0.' },
    ],
    wind: [
      { key: 'resource', label: 'Wind at 100 m', weight: 0.40, unit: 'm/s', lo: 5, hi: 9, read: windSpeed, source: 'gwa_ws100',
        why: 'Global Wind Atlas v4 mean speed at 100 m over usable land. 5 m/s scores 0, 9 m/s scores 100.' },
      { key: 'terrain', label: 'Terrain (median slope)', weight: 0.15, unit: '%', lo: 25, hi: 5, read: (c) => c.land && c.land.slopeMedianPct, source: 'dem',
        why: 'Median slope from Copernicus GLO-30. 5% or flatter scores 100, 25% or steeper scores 0.' },
      { key: 'area', label: 'Usable area', weight: 0.20, unit: 'ha', lo: 0, hi: 100, read: (c) => c.land && c.land.usableHa, source: 'worldcover',
        why: 'Eligible land cover, slope at or below the limit, outside protected areas. 100 ha or more scores 100.' },
      { key: 'grid', label: 'Distance to mapped substation', weight: 0.25, unit: 'km', lo: 25, hi: 2, read: gridKm, source: 'canvec',
        why: 'Nearest CanVec transformer station. 2 km or closer scores 100, 25 km or farther scores 0.' },
    ],
  };
  // A station beyond the search radius is a known bad value, not an unknown one.
  function gridKm(c) {
    const g = c.grid || {};
    if (num(g.stationKm)) return g.stationKm;
    if (g.reason && /no mapped transformer station within/.test(g.reason) && num(g.searchKm)) return { beyond: g.searchKm };
    return null;
  }
  function windSpeed(c) {
    const r = c.resource || {};
    if (c.land && num(c.land.usableHa) && c.land.usableHa > 0 && num(r.ws100Usable)) return r.ws100Usable;
    return num(r.ws100) ? r.ws100 : null;
  }

  const DEFAULTS = {
    minUsableHa: { solar: 2, wind: 20 },
    maxProtectedPct: 50,
    bands: { strong: 70, moderate: 45 },
    // A good site cannot make up for a weak resource: below this resource score the status is capped at moderate.
    strongNeedsResource: 70,
    gates: ['Land rights and landowner consent', 'Interconnection capacity and queue', 'Permits, setbacks and Indigenous consultation'],
  };

  // Every assumption carries where it came from. "placeholder" means not sourced: edit it.
  const ASSUMPTIONS = {
    priceCadPerMwh: {
      'ab-strathcona-demo': { value: 43.68, source: 'AESO 2025 Annual Market Statistics: average pool price 2025', url: 'https://www.aeso.ca/assets/Annual-Market-Stats-2025.pdf' },
      'bc-coquihalla': { value: 74, source: 'BC Hydro 2024 Call for Power: weighted average levelized price of accepted EPAs (2024$). Only awarded projects get it.', url: 'https://www.bchydro.com/news/press_centre/news_releases/2025/statement-bcuc-accepts-bc-hydro-2024-call-for-power-electricity-purchase-agreements.html' },
    },
    fxCadPerUsd: { value: 1.38, source: 'placeholder exchange rate: edit to the current rate' },
    discountRatePct: { value: 7, source: 'placeholder' },
    lifeYears: { value: 25, source: 'placeholder' },
    landCostCadPerHaYr: { value: null, source: 'not known: land rights are not assessed. Leave blank to show results before land cost.' },
    spurCadPerKm: { value: 1000000, source: 'placeholder cost of a new line to the substation' },
    connectionUsdPerKw: { value: 100, source: 'NREL ATB 2024 grid connection cost assumption, $100/kW (2022 USD)', url: 'https://atb.nrel.gov/electricity/2024/definitions' },
    solar: {
      densityMwPerHa: { value: 0.4, source: 'placeholder ground-mount density (MWdc per hectare)' },
      captureRatio: { value: 1.0, source: 'placeholder: share of the average price solar output earns. Alberta solar often earns less than the average.' },
      capexCadPerWdc: { value: 1.5, source: 'placeholder installed cost' },
      opexCadPerKwYr: { value: 25, source: 'placeholder' },
    },
    wind: {
      densityMwPerKm2: { value: 3, source: 'placeholder array density' },
      turbineMw: { value: 4.5, source: 'placeholder turbine rating' },
      lossPct: { value: 15, source: 'placeholder losses applied to the Global Wind Atlas gross capacity factor' },
      capexUsdPerKw: { value: 1968, source: 'NREL ATB 2025: 2023 market-average land-based turbine CAPEX $1,968/kW (Stehly et al., 2024)', url: 'https://atb.nlr.gov/electricity/2025/Land-Based_Wind' },
      opexUsdPerKwYr: { value: 43, source: 'NREL ATB 2025: 2023 market-average OPEX $43/kW/yr', url: 'https://atb.nlr.gov/electricity/2025/Land-Based_Wind' },
    },
  };
  // Flatten to plain numbers for a corridor: { priceCadPerMwh, fxCadPerUsd, ..., solar:{...}, wind:{...} }
  function assumptionValues(corridorId, overrides) {
    const v = (o) => o.value;
    const out = { priceCadPerMwh: (ASSUMPTIONS.priceCadPerMwh[corridorId] || { value: null }).value };
    for (const k of ['fxCadPerUsd', 'discountRatePct', 'lifeYears', 'landCostCadPerHaYr', 'spurCadPerKm', 'connectionUsdPerKw']) out[k] = v(ASSUMPTIONS[k]);
    for (const t of ['solar', 'wind']) out[t] = Object.fromEntries(Object.entries(ASSUMPTIONS[t]).map(([k, o]) => [k, o.value]));
    if (overrides) {
      for (const [k, val] of Object.entries(overrides)) {
        if (k === 'solar' || k === 'wind') Object.assign(out[k], val); else out[k] = val;
      }
    }
    return out;
  }

  function assess(c, cfg = DEFAULTS) {
    const defs = FACTORS[c.tech];
    if (!defs) throw new Error('unknown technology ' + c.tech);
    const factors = defs.map((d) => {
      const raw = d.read(c);
      if (raw && typeof raw === 'object' && num(raw.beyond)) {
        return { key: d.key, label: d.label, weight: d.weight, known: true, value: raw.beyond, unit: d.unit, display: `more than ${raw.beyond} ${d.unit}`, score: 0, why: d.why, source: d.source };
      }
      if (!num(raw)) return { key: d.key, label: d.label, weight: d.weight, known: false, value: null, unit: d.unit, display: 'unknown', score: null, why: d.why, source: d.source, reason: missingReason(c, d.key) };
      return { key: d.key, label: d.label, weight: d.weight, known: true, value: raw, unit: d.unit, display: `${round(raw, 2)} ${d.unit}`, score: round(ramp(raw, d.lo, d.hi), 1), why: d.why, source: d.source };
    });
    const knownW = factors.filter((f) => f.known).reduce((s, f) => s + f.weight, 0);
    const totalW = factors.reduce((s, f) => s + f.weight, 0);
    const coverage = round((knownW / totalW) * 100, 0);
    const partial = knownW > 0 ? round(factors.filter((f) => f.known).reduce((s, f) => s + f.weight * f.score, 0) / knownW, 1) : null;
    const missing = factors.filter((f) => !f.known);
    const land = c.land || {};
    let status, reason = null;
    if (num(land.protectedPct) && land.protectedPct >= cfg.maxProtectedPct) { status = 'excluded'; reason = `${land.protectedPct}% of the band is inside a protected or conserved area`; }
    else if (num(land.usableHa) && land.usableHa < cfg.minUsableHa[c.tech]) { status = 'excluded'; reason = `only ${land.usableHa} ha usable; at least ${cfg.minUsableHa[c.tech]} ha needed for ${c.tech}`; }
    else if (missing.length) { status = 'incomplete'; reason = 'missing: ' + missing.map((f) => f.label.toLowerCase()).join(', '); }
    else {
      status = partial >= cfg.bands.strong ? 'strong' : partial >= cfg.bands.moderate ? 'moderate' : 'weak';
      const res = factors.find((f) => f.key === 'resource');
      if (status === 'strong' && res.score < cfg.strongNeedsResource) { status = 'moderate'; reason = `capped at moderate: resource scores ${res.score}/100, below ${cfg.strongNeedsResource}`; }
    }
    const score = status === 'incomplete' || status === 'excluded' ? null : partial;
    const known = factors.filter((f) => f.known).sort((a, b) => b.score * b.weight - a.score * a.weight);
    const strongest = known.filter((f) => f.score >= 50).slice(0, 2);
    const weakest = known.filter((f) => f.score < 50).sort((a, b) => a.score - b.score).slice(0, 2);
    return { id: c.id, corridorId: c.corridorId, tech: c.tech, side: c.side, kmFrom: c.kmFrom, kmTo: c.kmTo, segmentIds: c.segmentIds,
      status, statusLabel: STATUS_LABEL[status], reason, score, partialScore: partial, coverage, factors, missing: missing.map((f) => f.key),
      gates: cfg.gates.slice(), explanation: explain(c, status, reason, strongest, weakest, missing, coverage) };
  }
  const STATUS_LABEL = { strong: 'Strong screen', moderate: 'Moderate screen', weak: 'Weak screen', excluded: 'Excluded', incomplete: 'Incomplete data' };
  function missingReason(c, key) {
    if (key === 'grid') return (c.grid && c.grid.reason) || 'no verified grid dataset for this area';
    if (key === 'area') return (c.land && c.land.usableReason) || 'land cover or slope not available';
    if (key === 'resource') return c.tech === 'wind' ? 'no wind-resource value at 100 m for this area' : 'no solar-resource value for this area';
    return 'input not available';
  }
  function explain(c, status, reason, strongest, weakest, missing, coverage) {
    const tech = c.tech === 'solar' ? 'Solar' : 'Wind';
    const parts = [];
    if (status === 'excluded') parts.push(`${tech} is excluded here: ${reason}.`);
    else if (status === 'incomplete') parts.push(`${tech} cannot be screened: ${missing.map((f) => f.label.toLowerCase() + ' is unknown (' + f.reason + ')').join('; ')}. Input coverage ${coverage}%.`);
    else parts.push(`${tech} screens ${status} on all four inputs${reason ? ' (' + reason + ')' : ''}.`);
    if (strongest.length) parts.push('Strongest: ' + strongest.map((f) => `${f.label.toLowerCase()} ${f.display} (${f.score}/100)`).join(', ') + '.');
    if (weakest.length) parts.push('Weakest: ' + weakest.map((f) => `${f.label.toLowerCase()} ${f.display} (${f.score}/100)`).join(', ') + '.');
    parts.push('Not assessed: land rights, interconnection capacity, permits.');
    return parts.join(' ');
  }

  function annuity(ratePct, years) {
    const r = ratePct / 100;
    return r === 0 ? years : (1 - Math.pow(1 + r, -years)) / r;
  }
  // Scenario money for one candidate. Returns nulls with reasons instead of guessing.
  function scenario(c, a, A) {
    const out = { mw: null, mwh: null, revenue: null, opex: null, landCost: null, capex: null, connectionCost: null, netBeforeLand: null, net: null, paybackYears: null, npv: null, turbines: null, reasons: [], landIncluded: false };
    if (a.status === 'excluded') { out.reasons.push('excluded: ' + a.reason); return out; }
    const land = c.land || {};
    if (!num(land.usableHa)) { out.reasons.push('usable area unknown'); return out; }
    if (!num(A.priceCadPerMwh)) out.reasons.push('electricity price not set');
    if (c.tech === 'solar') {
      const pv = c.resource && c.resource.pvout;
      out.mw = round(land.usableHa * A.solar.densityMwPerHa, 2);
      if (!num(pv)) out.reasons.push('solar yield unknown'); else out.mwh = round(out.mw * pv, 0);
      if (num(out.mwh) && num(A.priceCadPerMwh)) out.revenue = round(out.mwh * A.priceCadPerMwh * A.solar.captureRatio, 0);
      out.opex = round(out.mw * 1000 * A.solar.opexCadPerKwYr, 0);
      out.capexPlant = round(out.mw * 1e6 * A.solar.capexCadPerWdc, 0);
    } else {
      const cf = c.resource && c.resource.cfGross;
      const potential = (land.usableHa / 100) * A.wind.densityMwPerKm2;
      out.turbines = Math.floor(potential / A.wind.turbineMw + 1e-9);
      out.mw = round(out.turbines * A.wind.turbineMw, 2);
      if (out.turbines === 0) out.reasons.push(`usable land fits ${round(potential, 1)} MW, less than one ${A.wind.turbineMw} MW turbine`);
      if (!num(cf)) out.reasons.push('wind capacity factor unknown'); else out.mwh = round(out.mw * cf * (1 - A.wind.lossPct / 100) * 8760, 0);
      if (num(out.mwh) && num(A.priceCadPerMwh)) out.revenue = round(out.mwh * A.priceCadPerMwh, 0);
      out.opex = round(out.mw * 1000 * A.wind.opexUsdPerKwYr * A.fxCadPerUsd, 0);
      out.capexPlant = round(out.mw * 1000 * A.wind.capexUsdPerKw * A.fxCadPerUsd, 0);
    }
    const g = gridKm(c);
    if (!num(g)) out.reasons.push(g && g.beyond ? `no mapped substation within ${g.beyond} km: connection cost unknown` : 'grid distance unknown: connection cost unknown');
    else out.connectionCost = round(g * A.spurCadPerKm + out.mw * 1000 * A.connectionUsdPerKw * A.fxCadPerUsd, 0);
    if (num(out.connectionCost)) out.capex = out.capexPlant + out.connectionCost;
    if (num(out.revenue)) out.netBeforeLand = out.revenue - out.opex;
    if (num(A.landCostCadPerHaYr)) { out.landCost = round(land.usableHa * A.landCostCadPerHaYr, 0); out.landIncluded = true; }
    if (num(out.netBeforeLand)) out.net = out.netBeforeLand - (out.landCost || 0);
    if (num(out.net) && num(out.capex) && out.mw > 0) {
      out.paybackYears = out.net > 0 ? round(out.capex / out.net, 1) : null;
      if (out.net <= 0) out.reasons.push('operating margin is not positive at these assumptions');
      out.npv = round(-out.capex + out.net * annuity(A.discountRatePct, A.lifeYears), 0);
    }
    return out;
  }

  function assessCorridor(inputs, overrides) {
    const A = assumptionValues(inputs.corridorId, overrides);
    const rows = inputs.candidates.map((c) => {
      if (c.corridorId !== inputs.corridorId) throw new Error(`candidate ${c.id} belongs to ${c.corridorId}, not ${inputs.corridorId}`);
      const a = assess(c);
      return { ...a, scenario: scenario(c, a, A) };
    });
    const byId = Object.fromEntries(inputs.candidates.map((c) => [c.id, c]));
    return { corridorId: inputs.corridorId, assumptions: A, rows, totals: totals(rows), pooled: pooled(rows, byId, A) };
  }
  function totals(rows, keep = (r) => r.status === 'strong' || r.status === 'moderate') {
    const t = { candidates: 0, mw: 0, mwh: 0, revenue: 0, net: 0, capex: 0, npv: 0, unknownMoney: 0, byStatus: {} };
    for (const r of rows) {
      t.byStatus[r.status] = (t.byStatus[r.status] || 0) + 1;
      if (!keep(r)) continue;
      t.candidates++;
      const s = r.scenario;
      t.mw += s.mw || 0; t.mwh += s.mwh || 0; t.revenue += s.revenue || 0;
      if (num(s.net) && num(s.capex) && num(s.npv)) { t.net += s.net; t.capex += s.capex; t.npv += s.npv; } else t.unknownMoney++;
    }
    for (const k of ['mw', 'mwh', 'revenue', 'net', 'capex', 'npv']) t[k] = round(t[k], k === 'mw' ? 1 : 0);
    return t;
  }

  // One shared project per technology: the passing candidates pooled behind a single connection at the
  // nearest mapped substation. Standalone strips each paying for their own line is not how projects get built.
  function pooled(rows, inputsById, A, keep = (r) => r.status === 'strong' || r.status === 'moderate') {
    const out = {};
    for (const tech of ['solar', 'wind']) {
      const sel = rows.filter((r) => r.tech === tech && keep(r) && r.scenario && r.scenario.mw > 0);
      const p = { tech, candidates: sel.length, mw: 0, mwh: 0, revenue: 0, opex: 0, capexPlant: 0, stationKm: null, connectionCost: null, capex: null, net: null, landCost: null, paybackYears: null, npv: null, reasons: [] };
      for (const r of sel) {
        const s = r.scenario; p.mw += s.mw; p.mwh += s.mwh || 0; p.revenue += s.revenue || 0; p.opex += s.opex || 0; p.capexPlant += s.capexPlant || 0;
        if (!num(s.mwh)) p.reasons.push(r.id + ': energy unknown');
        const g = gridKm(inputsById[r.id]);
        if (num(g)) p.stationKm = p.stationKm == null ? g : Math.min(p.stationKm, g);
      }
      if (!sel.length) p.reasons.push('no candidate passes screening');
      else if (p.stationKm == null) p.reasons.push('no mapped substation distance: connection cost unknown');
      else {
        // Collector lines between strips are not costed; the spur runs from the nearest strip to the substation.
        p.connectionCost = round(p.stationKm * A.spurCadPerKm + p.mw * 1000 * A.connectionUsdPerKw * A.fxCadPerUsd, 0);
        p.capex = round(p.capexPlant + p.connectionCost, 0);
        if (num(A.landCostCadPerHaYr)) p.landCost = round(sel.reduce((t, r) => t + inputsById[r.id].land.usableHa, 0) * A.landCostCadPerHaYr, 0);
        p.net = round(p.revenue - p.opex - (p.landCost || 0), 0);
        p.paybackYears = p.net > 0 ? round(p.capex / p.net, 1) : null;
        if (p.net <= 0) p.reasons.push('operating margin is not positive at these assumptions');
        p.npv = round(-p.capex + p.net * annuity(A.discountRatePct, A.lifeYears), 0);
        // The electricity price at which this pooled project breaks even over its life (simple levelized check).
        const perMwh = p.mwh > 0 ? (p.capex / annuity(A.discountRatePct, A.lifeYears) + p.opex + (p.landCost || 0)) / p.mwh : null;
        p.breakEvenPriceCadPerMwh = round(tech === 'solar' && perMwh != null ? perMwh / A.solar.captureRatio : perMwh, 1);
      }
      for (const k of ['mw', 'mwh', 'revenue', 'opex', 'capexPlant']) p[k] = round(p[k], k === 'mw' ? 1 : 0);
      out[tech] = p;
    }
    return out;
  }

  const CSV_COLUMNS = ['id', 'corridorId', 'tech', 'side', 'kmFrom', 'kmTo', 'status', 'score', 'partialScore', 'coverage', 'resource', 'slopeMedianPct', 'usableHa', 'stationKm', 'protectedPct',
    'mw', 'mwh', 'revenueCad', 'netBeforeLandCad', 'capexCad', 'paybackYears', 'npvCad', 'missing', 'explanation'];
  function toCSV(rows, inputsById) {
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const f = (r, k) => (r.factors.find((x) => x.key === k) || {}).value;
    const lines = [CSV_COLUMNS.join(',')];
    for (const r of rows) {
      const c = inputsById ? inputsById[r.id] : null, s = r.scenario || {};
      lines.push([r.id, r.corridorId, r.tech, r.side, r.kmFrom, r.kmTo, r.status, r.score, r.partialScore, r.coverage, f(r, 'resource'), f(r, 'terrain'), f(r, 'area'), f(r, 'grid'),
        c && c.land ? c.land.protectedPct : '', s.mw, s.mwh, s.revenue, s.netBeforeLand, s.capex, s.paybackYears, s.npv, r.missing.join(' '), r.explanation].map(esc).join(','));
    }
    return lines.join('\n') + '\n';
  }

  const api = { FACTORS, DEFAULTS, ASSUMPTIONS, STATUS_LABEL, assumptionValues, assess, scenario, assessCorridor, totals, pooled, toCSV, ramp, gridKm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RENEWABLES = api;
})(typeof self !== 'undefined' ? self : this);
