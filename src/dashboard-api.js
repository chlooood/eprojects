// Builds the corridor JSON the dashboard reads (GET /corridor) from the Data Tables the n8n workflows write:
//   corridor_segments (W1), corridor_baselines + corridor_predictions (W2), corridor_build + corridor_build_config (W5),
//   corridor_watch (W3 near-term state, W4 tier overrides), corridor_work_orders (W4).
// Pure function: rows in, one JSON object out. Fail closed: anything missing stays null or 'unverified', never green.
// scripts/make-api-workflow.js pastes this file into the API workflow's Code node. Edit this file, not the node.

// One tier mapping for src/engine.js, this feed and the n8n W2 Config node. Provisional, see docs/THRESHOLDS.md.
const TIERS = { amber: 40, red: 65 }, RATIO_FULL = 0.5;
const W_RAIN = 0.35, W_FT = 0.20, W_SAT = 0.15, W_VEG = 0.20, W_SLOPE = 0.10; // same weights as the W2 Config node
const MODELS = ['MRI_AGCM3_2_S', 'EC_Earth3P_HR', 'MPI_ESM1_2_XR'];

function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function rnd(v, d) { if (v === null || v === undefined || !Number.isFinite(v)) return null; const f = Math.pow(10, d); return Math.round(v * f) / f; }
function parseJson(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return dflt; }
}
const real = (rows) => (rows || []).filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);

// Area of a [lon, lat] ring in square metres (local equirectangular projection, fine at 1 km scale).
function ringAreaM2(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * kx * ring[i + 1][1] * ky - ring[i + 1][0] * kx * ring[i][1] * ky;
  return Math.abs(s) / 2;
}

function geometryOf(seg) {
  const fc = parseJson(seg.polygon_geometry_json, null);
  const feats = (fc && fc.features) || [];
  const zone = (z) => feats.find((f) => f.properties && f.properties.zone === z);
  const cl = zone('centreline');
  const st = zone('study_strip');
  const centreline = cl && cl.geometry && Array.isArray(cl.geometry.coordinates) && cl.geometry.coordinates.length >= 2
    ? cl.geometry.coordinates
    : (num(seg.lon_start) !== null && num(seg.lon_end) !== null ? [[num(seg.lon_start), num(seg.lat_start)], [num(seg.lon_end), num(seg.lat_end)]] : []);
  let studyPolygon = [], areaM2 = 0;
  if (st && st.geometry && st.geometry.type === 'MultiPolygon') {
    for (const poly of st.geometry.coordinates) for (const ring of poly) { areaM2 += ringAreaM2(ring); studyPolygon = studyPolygon.concat(ring); }
  }
  return { centreline, studyPolygon, studyAreaAcres: areaM2 > 0 ? rnd(areaM2 / 4046.8564224, 1) : null };
}

function buildCorridor(t, opts) {
  opts = opts || {};
  const now = opts.now || new Date().toISOString();
  const allSegs = real(t.segments).filter((s) => s.segment_id);
  const corridorId = opts.corridorId || (allSegs[0] && allSegs[0].corridor_id) || 'unknown';
  const segs = allSegs.filter((s) => !s.corridor_id || s.corridor_id === corridorId)
    .sort((a, b) => Number(a.segment_index) - Number(b.segment_index));

  const byId = (rows) => { const m = {}; for (const r of real(rows)) if (r.segment_id) m[r.segment_id] = r; return m; };
  const baselines = byId(t.baselines), build = byId(t.build), watch = byId(t.watch);
  const preds = {};
  for (const p of real(t.predictions)) {
    if (!p.segment_id) continue;
    (preds[p.segment_id] = preds[p.segment_id] || {})[String(Number(p.horizon_years))] = p;
  }
  const workOrders = {};
  for (const w of real(t.workOrders).sort((a, b) => String(a.drafted_at || '').localeCompare(String(b.drafted_at || '')))) {
    if (w.segment_id) workOrders[w.segment_id] = w; // newest wins
  }
  const cfgRow = real(t.buildConfig).filter((r) => !r.corridor_id || r.corridor_id === corridorId)[0];
  const saved = cfgRow ? parseJson(cfgRow.config_json, {}) || {} : {};

  let kmCursor = 0, latestComputed = '', synthetic = false, cachedOsm = false;
  const segments = segs.map((s, idx) => {
    const lengthM = num(s.length_m) || 0;
    const kmFrom = rnd(kmCursor, 3);
    kmCursor += lengthM / 1000;
    const kmTo = rnd(kmCursor, 3);
    const g = geometryOf(s);
    if (/fixture|fallback|synthetic/i.test(String(s.source_kind || ''))) synthetic = true;
    if (/osm_cached/i.test(String(s.source_kind || ''))) cachedOsm = true;

    const b = baselines[s.segment_id] || {};
    const bd = build[s.segment_id] || {};
    const slopePct = num(b.slope_pct);
    const baseRain = num(b.extreme_rain_days_per_yr), baseFt = num(b.freeze_thaw_days_per_yr), baseWet = num(b.saturation_days_per_yr);
    const series = parseJson(b.ndvi_series_json, []);
    const ndviSeries = (Array.isArray(series) ? series : [])
      .filter((p) => p && num(p.mean) !== null && p.month)
      .map((p) => ({ date: String(p.month).slice(0, 7) + '-15', ndvi: num(p.mean) }));
    const drop = num(b.ndvi_drop_5yr);
    const change5yr = drop === null ? null : rnd(-drop, 3);
    const ndvi = {
      slopePerYr: num(b.ndvi_slope_per_yr), change5yr,
      meanNdvi: ndviSeries.length ? rnd(ndviSeries.reduce((a, p) => a + p.ndvi, 0) / ndviSeries.length, 3) : null,
      n: ndviSeries.length, source: b.ndvi_source || 'unavailable',
    };
    const yrs = String(b.baseline_period || '').match(/(\d{4})\D+(\d{4})/);
    const baseline = {
      years: yrs ? Number(yrs[2]) - Number(yrs[1]) + 1 : null,
      extremeMm: num(b.rain_p95_mm), soilWetThreshold: num(b.soil_p90_m3m3),
      extremeDaysPerYr: baseRain, freezeThawDaysPerYr: baseFt, wetSoilDaysPerYr: baseWet, annualPrecipMm: null,
    };

    const projections = { y5: {}, y10: {} };
    const risk = {};
    let crossings, crossingsChecked = false;
    for (const h of [5, 10]) {
      const key = 'y' + h, p = (preds[s.segment_id] || {})[String(h)];
      if (p && p.computed_at && String(p.computed_at) > latestComputed) latestComputed = String(p.computed_at);
      const perModel = p ? parseJson(p.model_scores_json, {}) || {} : {};
      for (const m of Object.keys(perModel)) {
        const pm = perModel[m] || {};
        const rr = num(pm.rain_ratio), fr = num(pm.freeze_thaw_ratio), sr = num(pm.saturation_ratio);
        projections[key][m] = {
          extremeDaysPerYr: baseRain !== null && rr !== null ? rnd(baseRain * rr, 2) : null,
          freezeThawDaysPerYr: baseFt !== null && fr !== null ? rnd(baseFt * fr, 2) : null,
          wetSoilDaysPerYr: baseWet !== null && sr !== null ? rnd(baseWet * sr, 2) : null,
          refExtremeDaysPerYr: baseRain, refFreezeThawDaysPerYr: baseFt, refWetSoilDaysPerYr: baseWet,
          method: 'delta (baseline x model ratio from W2)',
        };
      }
      const verified = p && p.status === 'verified' && num(p.risk_score) !== null;
      if (!verified) {
        risk[key] = { score: null, tier: 'unverified', agreement: '', factors: {}, drivers: [], method: p ? 'unverified: ' + (p.error_message || 'missing input') : 'not scored yet', error: p ? (p.error_message || '') : 'no W2 row' };
        continue;
      }
      const f = { rain: num(p.score_r), freezeThaw: num(p.score_f), saturation: num(p.score_w), vegetation: num(p.score_v), slope: num(p.score_s) };
      const ratio = (x) => (x === null ? null : rnd((x - 1) * 100, 0));
      const drivers = [
        { key: 'rain', label: 'Extreme-rain days', change: ratio(num(p.rain_ratio)), base: baseRain, proj: baseRain !== null && num(p.rain_ratio) !== null ? rnd(baseRain * num(p.rain_ratio), 1) : null, w: W_RAIN * (f.rain || 0) },
        { key: 'freezeThaw', label: 'Freeze-thaw days', change: ratio(num(p.freeze_thaw_ratio)), base: baseFt, proj: baseFt !== null && num(p.freeze_thaw_ratio) !== null ? rnd(baseFt * num(p.freeze_thaw_ratio), 1) : null, w: W_FT * (f.freezeThaw || 0) },
        { key: 'saturation', label: 'Wet-soil days', change: ratio(num(p.saturation_ratio)), base: baseWet, proj: baseWet !== null && num(p.saturation_ratio) !== null ? rnd(baseWet * num(p.saturation_ratio), 1) : null, w: W_SAT * (f.saturation || 0) },
        { key: 'vegetation', label: 'Vegetation change (NDVI, 5 yr)', change: change5yr, w: W_VEG * (f.vegetation || 0) },
        { key: 'slope', label: 'Slope', change: slopePct, w: W_SLOPE * (f.slope || 0) },
      ].sort((a, c) => c.w - a.w);
      const agreement = p.model_agreement || '';
      // Per-hazard result written by W2 (hazards_json). Rows from an older W2 run have none: then only ground failure
      // is known, and the other three are reported as not computed, never as low.
      const hz = parseJson(p.hazards_json, null);
      const tierOf = (v) => (v >= TIERS.red ? 'red' : v >= TIERS.amber ? 'amber' : 'green');
      let hazards, hazardStatus, top = 'ground', groundScore = num(p.risk_score);
      if (hz && hz.hazards && hz.hazards.ground) {
        hazards = hz.hazards; hazardStatus = hz.status || {}; top = hz.top || 'ground'; groundScore = num(hz.ground_score);
        if (h === 10 || crossings === undefined) {
          crossingsChecked = Array.isArray(hz.crossings);
          crossings = crossingsChecked ? hz.crossings : undefined;
          for (const k of ['drySoilDaysPerYr', 'drySpellDays', 'fireWeatherDaysPerYr']) if (hz.base && num(hz.base[k]) !== null) baseline[k] = num(hz.base[k]);
        }
      } else {
        const d0 = drivers[0];
        hazards = { ground: { key: 'ground', label: 'Ground failure', score: groundScore, tier: tierOf(groundScore),
          why: d0 && d0.w > 0 && d0.change !== null ? (d0.key === 'slope' ? 'Slope ' + d0.change + '%' : d0.key === 'vegetation' ? 'Plant cover ' + d0.change + ' NDVI in 5 years' : d0.label + ' ' + (d0.change > 0 ? '+' : '') + d0.change + '%') : 'No change from baseline' } };
        const nc = 'not computed: this W2 run predates the multi-hazard scoring';
        hazardStatus = { ground: 'scored', crossing: nc, wildfire: nc, drought: nc };
      }
      const rainBased = top === 'ground' || top === 'crossing';
      risk[key] = {
        score: num(p.risk_score), groundScore, hazard: top, hazards, hazardStatus,
        tier: p.tier === 'red' && agreement === 'low' && rainBased ? 'red-uncertain' : p.tier,
        agreement, factors: f, drivers, method: 'weighted-rules (n8n W2)',
        window: [Number(String(p.window_start || '').slice(0, 4)) || null, Number(String(p.window_end || '').slice(0, 4)) || null],
        computedAt: p.computed_at || null,
      };
    }

    const w = watch[s.segment_id] || {};
    const override = w.override_tier
      ? { tier: w.override_tier, reason: w.override_reason || '', horizon: w.override_horizon === 'y5' ? 5 : 10, by: w.override_by || null, at: w.override_at || null }
      : null;
    const wo = workOrders[s.segment_id];
    const facts = wo ? parseJson(wo.facts_json, []) : [];
    const fact = (prefix) => (Array.isArray(facts) ? facts : []).find((x) => typeof x === 'string' && x.startsWith(prefix))?.slice(prefix.length) || null;
    const due = fact('Due by: ');
    const checks = (Array.isArray(facts) ? facts : []).filter((x) => typeof x === 'string' && /^Check \d+: /.test(x)).map((x) => x.replace(/^Check \d+: /, ''));
    const p10 = (preds[s.segment_id] || {})['10'], p5 = (preds[s.segment_id] || {})['5'];
    return {
      id: s.segment_id, index: idx, kmFrom, kmTo, lengthM: Math.round(lengthM),
      centreline: g.centreline, studyPolygon: g.studyPolygon.length ? g.studyPolygon : g.centreline,
      studyAreaAcres: g.studyAreaAcres,
      baseline, projections, slopePct, ndvi, ndviSeries, crossings, crossingsChecked,
      irradiance: num(bd.irradiance), substationKm: num(bd.substation_km),
      risk,
      explanation: String((p10 && p10.explanation) || (p5 && p5.explanation) || ''),
      override,
      nearTerm: w.near_term_state ? { state: w.near_term_state, summary: w.near_term_summary || '', checkedAt: w.near_term_checked_at || null } : null,
      // What n8n actually recorded. 'approved' means stored in corridor_work_orders with that status, nothing more:
      // no email, no maintenance-system ticket and no crew dispatch happens in this MVP.
      workOrder: wo ? { id: wo.work_order_id, status: wo.status, priority: wo.priority, tier: wo.tier,
        score: num(wo.score), dueBy: due ? due.slice(0, 10) : null, why: fact('Main driver: '),
        checks: checks.length ? checks : null, mapUrl: fact('Location: '), hazard: fact('Worst hazard: '),
        summary: wo.summary || '', draftedAt: wo.drafted_at || null, decidedAt: wo.decided_at || null, decidedBy: wo.decided_by || null,
        triggerSource: wo.trigger_source || null, deliveryState: wo.delivery_state || 'not_configured', deliveryRecipient: wo.delivery_recipient || null, deliveryAcceptedAt: wo.delivery_accepted_at || null, storedIn: 'corridor_work_orders (n8n Data Table)',
        nextStep: wo.status === 'approved' ? 'Inspection coordinator exports the CSV from the Work orders page into the maintenance system' : wo.status === 'pending_approval' ? 'Waiting for the integrity manager to approve or reject' : 'None' } : null,
      sourceKind: s.source_kind || null,
    };
  });

  const money = {};
  if (num(saved.acresPerMW) !== null) money.acresPerMW = num(saved.acresPerMW);
  if (num(saved.performanceRatio) !== null) money.performanceRatio = num(saved.performanceRatio);
  if (num(saved.leaseRatePerAcreYr) !== null) money.leaseRatePerAcreYr = num(saved.leaseRatePerAcreYr);
  if (num(saved.partnerShare) !== null) money.partnerShare = num(saved.partnerShare);
  if (num(saved.gridEmissionFactor) !== null) money.gridEmissionFactor = num(saved.gridEmissionFactor);
  const windowOf = (k) => { const s = segments.find((x) => x.risk[k] && x.risk[k].window && x.risk[k].window[0]); return s ? s.risk[k].window : null; };
  const hazardsLive = ['ground', 'crossing', 'wildfire', 'drought'].filter((k) => segments.some((x) => x.risk.y10.hazards && x.risk.y10.hazards[k]));
  const config = {
    weights: { rain: W_RAIN, freezeThaw: W_FT, saturation: W_SAT, vegetation: W_VEG, slope: W_SLOPE },
    tiers: TIERS, ratioFull: RATIO_FULL, ndviDropFull: 0.1, slopeFullPct: 10,
    // The windows W2 actually averaged over (inclusive years). Non-overlapping: 2026-2030 and 2031-2035.
    horizons: { y5: windowOf('y5') || [2026, 2030], y10: windowOf('y10') || [2031, 2035] },
    money,
  };
  if (num(saved.buildStripM) !== null) config.buildStripM = num(saved.buildStripM);
  if (num(saved.maxBuildSlopePct) !== null) config.buildMaxSlopePct = num(saved.maxBuildSlopePct);
  if (num(saved.exclusionBandM) !== null) config.exclusionM = num(saved.exclusionBandM);
  if (num(saved.studyStripWidthM) !== null) config.studyStripM = num(saved.studyStripWidthM);

  const verified = segments.filter((s) => s.risk.y10.tier !== 'unverified').length;
  return {
    meta: {
      name: opts.name || corridorId, corridorId, synthetic,
      note: synthetic
        ? 'Route is the embedded fallback fixture (Overpass failed or was not used). Weather history is cached from a laptop run. Scores come from n8n W2.'
        : cachedOsm
          ? 'Route is a real pipeline way from OpenStreetMap near Edmonton (OSM tags it Trans-Northern; not verified, and no operator is involved), cached from a laptop run because Overpass times out from n8n Cloud. Weather history and climate projections are cached per 10 km cell from a laptop run. Scores come from n8n W2.'
          : 'Route from OpenStreetMap via W1. Scores come from n8n W2.',
      models: MODELS, generatedAt: latestComputed || now, servedAt: now,
      source: 'n8n Data Tables', segmentsTotal: segments.length, segmentsVerified: verified,
      hazardsScored: hazardsLive, crossingsChecked: segments.filter((x) => x.crossingsChecked).length,
    },
    config,
    substations: [],
    segments,
    audit: real(t.audit).filter((a) => segments.some((s) => s.id === a.segment_id)).map((a) => ({ at: a.logged_at, segment: a.segment_id, action: a.action || 'unknown', by: a.actor, details: parseJson(a.details_json, {}), note: 'stored in n8n' })),
  };
}

if (typeof module !== 'undefined') module.exports = { buildCorridor, ringAreaM2 };
