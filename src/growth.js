// TerraCorridor growth model: how likely each kilometre is to change class, and when.
// Land moves through stages: inside a neighbourhood plan with nothing built, building starts, the block builds
// out, homes are lived in. Every step is measured from City of Edmonton records (data/cache/growth/):
//   start:      how likely a 200 m block in a plan is to start building in a year, given how close and how
//               recently the nearest block started (a life table over 1,920 blocks in 33 plans, 2011 to 2025)
//   build-out:  how fast a started block fills, and how many homes it ends with (303 finished blocks)
//   approval:   how likely a development permit is to become a building permit, and how soon (10,101 matched)
//   move-in:    months from building permit to occupancy granted (8,231 homes)
// A Monte Carlo simulation runs many possible futures and counts dwellings in the 1.6 km class location
// window each quarter. Results are chances, with the spread of dates, never a single "answer".
(function (root) {
  const SEG = root.TC_SEGMENTS || require('./segments.js');
  const CLASS = root.TC_CLASS || require('./classlocation.js');

  const DEFAULTS = {
    runs: 1000, seed: 20261116, to: '2035-12-31', binM: 200,
    cellsPerBin: 2,            // a 200 m bin of the line is 200 m long and 200 m each side: about two 4 ha grid cells (homes scale with area)
    startCells: 1,             // but a bin starts like one block: land along a pipeline builds together or not at all
    prior: [0.5, 10],          // weak prior on each start rate: (starts + 0.5) / (block-years + 10)
    completeQuietYears: 3,     // a started bin with no building permit in this many years is treated as built out
    builtBeforeRoofs: 20,      // a bin with this many 2019 roofs and no permits since 2009 was built before 2009
    apartmentLagMonths: 20,    // assumption: too few apartments have an occupancy date to measure
  };
  const BUCKETS = ['none', 'adjRecent', 'adjOld', 'nearRecent', 'nearOld'];
  const LABEL = { none: 'nothing started within 600 m', adjRecent: 'next door started in the last 2 years', adjOld: 'next door started 2+ years ago', nearRecent: '400 to 600 m away started in the last 2 years', nearOld: '400 to 600 m away started 2+ years ago' };

  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const dy = (iso) => { const d = new Date(SEG.day(iso) + 'T00:00:00Z'), y = d.getUTCFullYear(); return y + (d - Date.UTC(y, 0, 1)) / (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)); };
  const iso = (t) => { const y = Math.floor(t), ms = Date.UTC(y, 0, 1) + (t - y) * (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)); return new Date(ms).toISOString().slice(0, 10); };
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

  // ---- fitting
  function fitHazard(table, upToYear = 9999, prior = DEFAULTS.prior) {
    const s = Object.fromEntries(BUCKETS.map((b) => [b, [0, 0]]));
    for (const [k, v] of Object.entries(table)) { const [y, b] = k.split(':'); if (+y > upToYear || !s[b]) continue; s[b][0] += v[0]; s[b][1] += v[1]; }
    return Object.fromEntries(BUCKETS.map((b) => [b, { blockYears: s[b][0], starts: s[b][1], perYear: (s[b][1] + prior[0]) / (s[b][0] + prior[1]), label: LABEL[b] }]));
  }
  function fitBuildout(cells, cutoff = 9999) {
    return cells.filter((c) => c[0] + c[2] <= cutoff).map(([start, t50, t90, units]) => {
      const a = Math.max(0.05, t50), b = Math.max(a + 0.05, t90);
      return { start, t50: a, t90: b, end: b + Math.max(0.5, b - a), units };
    });
  }
  const share = (c, t) => (t <= 0 ? 0 : t <= c.t50 ? 0.5 * t / c.t50 : t <= c.t90 ? 0.5 + 0.4 * (t - c.t50) / (c.t90 - c.t50) : t <= c.end ? 0.9 + 0.1 * (t - c.t90) / (c.end - c.t90) : 1);
  // Months from a histogram: bin i is [i, i+1) months; the last bin is open-ended (+12 months spread).
  function sampleHist(hist, r, from = 0) {
    const lo = Math.max(0, Math.floor(from)); let tot = 0; for (let i = lo; i < hist.length; i++) tot += hist[i];
    if (!tot) return from; let x = r() * tot;
    for (let i = lo; i < hist.length; i++) { x -= hist[i]; if (x <= 0) { const w = i === hist.length - 1 ? 12 : 1; return Math.max(from, i + r() * w); } }
    return from;
  }
  function fit(data, opts = {}) {
    const cutoff = opts.cutoffYear || 9999;
    // Cure model: some plan land never gets homes. Start rates are fitted on the land that does build.
    const cures = data.startHazard.buildable || {}, cy = Object.keys(cures).map(Number).filter((y) => y <= cutoff).sort((a, b) => b - a)[0];
    const cure = cy ? cures[cy] : null;
    const hazard = fitHazard(cure ? cure.table : data.startHazard.table, cutoff, opts.prior || DEFAULTS.prior), curves = fitBuildout(data.buildout.cells, cutoff);
    const neverShare = cure ? cure.share : 0;
    const conv = data.devToBuilding, occ = data.buildingToOccupied;
    const converted = conv.hist.reduce((a, b) => a + b, 0);
    const occLag = (h) => { const out = []; h.forEach((n, i) => { for (let k = 0; k < n; k++) out.push(i + 0.5); }); return median(out); };
    return { cutoffYear: opts.cutoffYear || null, hazard, curves, conv, occ, neverShare, allLand: fitHazard(data.startHazard.table, cutoff),
      summary: { neverShare, curedFromPlans: cure ? cure.maturePlans : 0, blocksStarted: Object.values(hazard).reduce((a, b) => a + b.starts, 0), finishedBlocks: curves.length, medianYearsTo90: median(curves.map((c) => c.t90)), medianUnitsPerBlock: median(curves.map((c) => c.units)),
        devToBuildingRate: converted / (converted + conv.never), devToBuildingMedianMonths: occLag(conv.hist), moveInMedianMonths: occLag(occ.hist.house) } };
  }

  // ---- the line, as of a date
  function lineState(segments, permits, neighbours, asOf, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts }, index = SEG.buildIndex(segments), state = CLASS.normalize(permits, index), B = cfg.binM;
    const nb = Math.ceil(index.lengthM / B), base = state.baseline ? state.baseline.date : '0000-00-00', T0 = dy(asOf);
    const bins = Array.from({ length: nb }, (_, k) => ({ k, roofs: 0, res: false, bp: [], dp: [], permitsToBase: 0, start: null, last: null, permitsNow: 0, near: (neighbours && neighbours[k]) || [] }));
    if (state.baseline) for (const [k, v] of Object.entries(state.baseline.bins)) if (+k < nb) bins[+k].roofs = v;
    for (const p of state.plans) if (p.residential && p.bins) for (const b of p.bins) if (b < nb) bins[b].res = true;
    for (const e of state.events.sort((a, b) => a.issued.localeCompare(b.issued))) {
      if (e.issued > SEG.day(asOf)) continue;
      const b = bins[Math.min(nb - 1, Math.max(0, Math.floor(e.chainageM / B)))];
      if (e.kind === 'building_permit') {
        b.permitsNow += e.units; if (e.issued <= base) b.permitsToBase += e.units;
        if (b.start == null && b.permitsNow >= 3) b.start = dy(e.issued);
        b.last = dy(e.issued);
        b.bp.push({ t: dy(e.issued), units: e.units, type: e.type, afterBase: e.issued > base });
      } else if (e.kind === 'development_permit') b.dp.push({ t: dy(e.issued), units: e.units });
    }
    for (const b of bins) {
      const bpSince = b.bp.filter((x) => state.devSince && x.t >= dy(state.devSince)).reduce((a, x) => a + x.units, 0), dpTot = b.dp.reduce((a, x) => a + x.units, 0);
      const keep = dpTot ? Math.max(0, dpTot - bpSince) / dpTot : 0; for (const d of b.dp) d.units *= keep;
      b.stage = b.start == null ? (b.roofs >= cfg.builtBeforeRoofs ? 'built' : b.res ? 'planned' : 'outside') : (T0 - b.last >= cfg.completeQuietYears ? 'built' : b.res ? 'building' : 'built');
      b.near = b.near.filter((n) => n[1] <= T0);
    }
    return { index, nb, bins, T0, baseline: base, devSince: state.devSince };
  }

  // Grow the line forward in many futures. mode 'roofs' counts today's stock as 2019 roofs plus permits since;
  // mode 'reconstruct' (hindcast) rebuilds the stock before 2009 so a past date can be the starting point.
  function simulate(segments, permits, data, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts }, asOf = SEG.day(opts.asOf || permits.fetchedAt || new Date());
    const F = opts.fitted || fit(data, { cutoffYear: opts.cutoffYear });
    const S = lineState(segments, permits, data.lineNeighbours && data.lineNeighbours.bins, asOf, cfg), r = rng(cfg.seed);
    const T0 = S.T0, T1 = dy(cfg.to), steps = []; for (let t = Math.ceil(T0 * 4) / 4; t <= T1 + 1e-9; t += 0.25) steps.push(t); if (steps[steps.length - 1] < T1 - 1e-9) steps.push(T1);
    const nb = S.nb, W = Math.round(CLASS.DEFAULTS.windowM / cfg.binM), thr = CLASS.DEFAULTS.thresholds;
    const bD = dy(S.baseline === '0000-00-00' ? '1900-01-01' : S.baseline);
    // calibration: homes per bin = block units x cellsPerBin x k, with k from this line's own finished bins
    const lineDone = S.bins.filter((b) => b.res && b.start != null && b.stage === 'built').map((b) => b.roofs - b.permitsToBase + b.permitsNow);
    const cityMed = median(F.curves.map((c) => c.units)) * cfg.cellsPerBin, k = lineDone.length >= 3 && cityMed ? median(lineDone) / cityMed : 1;
    const curves = F.curves.map((c) => ({ ...c, units: c.units * cfg.cellsPerBin * k }));
    const houseHist = F.occ.hist.house, rowHist = F.occ.hist.row;
    const lagOf = (type) => (/^(310|315|522)$/.test(type) ? cfg.apartmentLagMonths : sampleHist(/^(330|335)$/.test(type) ? rowHist : houseHist, r)) / 12;
    const convHist = F.conv.hist, never = F.conv.never;
    const pConv = (m) => { let s = 0; for (let i = Math.max(0, Math.floor(m)); i < convHist.length; i++) s += convHist[i]; return s / (s + never); };
    const stockOf = (b) => (cfg.mode === 'reconstruct' ? Math.max(0, b.roofs - b.permitsToBase) : b.roofs);
    const counted = (x) => (cfg.mode === 'reconstruct' ? true : x.afterBase);
    const segs = S.index.ranges.map((rg) => ({ id: rg.id, from: rg.fromM, to: rg.toM, wins: [] }));
    for (const s of segs) for (let st = Math.max(0, Math.floor((s.from - CLASS.DEFAULTS.windowM) / cfg.binM) + 1); st * cfg.binM < s.to; st++) s.wins.push(st);
    const cross = Object.fromEntries(segs.map((s) => [s.id, { 2: [], 3: [] }]));
    const addSum = steps.map(() => new Float64Array(nb)), startedBy = steps.map(() => new Float64Array(nb));
    const occ = steps.map(() => new Float64Array(nb)), pre = new Float64Array(nb + 1);
    for (let run = 0; run < cfg.runs; run++) {
      // per bin: permits as a function of time, then shifted by a move-in lag
      const plans = S.bins.map((b) => ({ buildable: b.stage !== 'planned' || r() >= F.neverShare, start: b.stage === 'planned' ? null : b.start, curve: null, F: 0, fromUnits: b.permitsNow, e0: 0, lag: lagOf('110'), extra: [] }));
      for (const b of S.bins) {
        const p = plans[b.k];
        for (const d of b.dp) { const m = (T0 - d.t) * 12; if (!d.units || r() > pConv(m)) continue; const tb = T0 + (sampleHist(convHist, r, m) - m) / 12;
          if (b.stage === 'planned') { if (p.start == null || tb < p.start) p.start = tb; } else if (b.stage !== 'building') p.extra.push({ t: tb, units: d.units }); }
        if (b.stage === 'building') { const fits = curves.filter((c) => c.units > b.permitsNow); if (fits.length) { p.curve = fits[Math.floor(r() * fits.length)]; p.F = p.curve.units; p.e0 = T0 - b.start; } }
      }
      const startedAt = (k, t) => plans[k].start != null && plans[k].start <= t;
      // planned bins: step through quarters, the start chance set by the nearest started block
      for (let i = 0; i < steps.length; i++) {
        const t = steps[i], prev = i ? steps[i - 1] : T0, dt = t - prev; if (dt <= 0) continue;
        for (const b of S.bins) {
          if (b.stage !== 'planned' || !plans[b.k].buildable || startedAt(b.k, prev)) continue;
          let best = null;
          for (const [d, s0] of b.near) if (s0 < prev && (!best || d < best.d || (d === best.d && s0 > best.s))) best = { d, s: s0 };
          for (let dk = -3; dk <= 3; dk++) { const j = b.k + dk; if (!dk || j < 0 || j >= nb || !startedAt(j, prev)) continue; const d = Math.abs(dk), s0 = plans[j].start; if (!best || d < best.d || (d === best.d && s0 > best.s)) best = { d, s: s0 }; }
          const bucket = !best ? 'none' : (best.d <= 1 ? 'adj' : 'near') + (prev - best.s < 2 ? 'Recent' : 'Old');
          const h = 1 - Math.pow(1 - F.hazard[bucket].perYear, cfg.startCells * dt);
          if (r() < h) { const st = prev + r() * dt; if (plans[b.k].start == null || st < plans[b.k].start) plans[b.k].start = st; }
        }
      }
      for (const b of S.bins) { const p = plans[b.k]; if (b.stage === 'planned' && p.start != null) { p.curve = curves[Math.floor(r() * curves.length)]; p.F = p.curve.units; p.fromUnits = 0; p.e0 = 0; p.base0 = p.start; } }
      // occupied dwellings per bin at each step
      for (let i = 0; i < steps.length; i++) {
        const t = steps[i];
        for (const b of S.bins) {
          const p = plans[b.k]; let n = stockOf(b);
          for (const x of b.bp) if (counted(x)) { if (x.lagT == null || run !== x.run) { x.lagT = lagOf(x.type); x.run = run; } if (x.t + x.lagT <= t) n += x.units; }
          const tp = t - p.lag; let fut = 0;
          if (p.curve && p.start != null && tp > (b.stage === 'planned' ? p.start : T0)) {
            if (b.stage === 'planned') fut = p.F * share(p.curve, tp - p.start);
            else { const g0 = share(p.curve, p.e0); fut = g0 >= 1 ? 0 : (p.F - b.permitsNow) * (share(p.curve, p.e0 + tp - T0) - g0) / (1 - g0); }
          }
          for (const x of p.extra) if (x.t + p.lag <= t) fut += x.units;
          n += Math.max(0, fut);
          occ[i][b.k] = n; addSum[i][b.k] += fut; if (p.start != null && p.start <= t) startedBy[i][b.k] += 1;
        }
      }
      // class crossings per segment
      for (const s of segs) { const c = cross[s.id]; c.now = c.now || 0; }
      const first = Object.fromEntries(segs.map((s) => [s.id, { 2: null, 3: null }]));
      for (let i = 0; i < steps.length; i++) {
        pre[0] = 0; for (let k = 0; k < nb; k++) pre[k + 1] = pre[k] + occ[i][k];
        for (const s of segs) { let mx = 0; for (const st of s.wins) mx = Math.max(mx, pre[Math.min(nb, st + W)] - pre[Math.min(nb, st)]);
          const f = first[s.id]; if (f[2] == null && mx >= thr.class2) f[2] = i === 0 ? T0 : steps[i - 1] + r() * (steps[i] - steps[i - 1]); if (f[3] == null && mx >= thr.class3) f[3] = i === 0 ? T0 : steps[i - 1] + r() * (steps[i] - steps[i - 1]); }
      }
      for (const s of segs) for (const c of [2, 3]) if (first[s.id][c] != null) cross[s.id][c].push(first[s.id][c]);
      for (const b of S.bins) for (const x of b.bp) delete x.lagT;
    }
    const N = cfg.runs, years = []; for (let y = Math.floor(T0); y <= Math.floor(T1); y++) years.push(y);
    const stepAt = (y) => { let j = 0; for (let i = 0; i < steps.length; i++) if (steps[i] <= y + 1 + 1e-9) j = i; return j; };
    const now = CLASS.forecast(segments, permits, CLASS.DEFAULTS, asOf).bySegment;
    const bySegment = {};
    for (const s of segs) {
      const cl = now[s.id] ? now[s.id].class.now : 1, out = { classNow: cl, byYear: {}, cross: {} };
      for (const c of [2, 3]) {
        const xs = cross[s.id][c].sort((a, b) => a - b), q = (p) => (xs.length ? +xs[Math.min(xs.length - 1, Math.floor(p * xs.length))].toFixed(2) : null);
        out.cross[c] = cl >= c ? { already: true, p: 1 } : { already: false, p: xs.length / N, q10: q(0.1), q50: q(0.5), q90: q(0.9), samples: xs.map((x) => +x.toFixed(3)) };
      }
      for (const y of years) out.byYear[y] = { 2: cl >= 2 ? 1 : cross[s.id][2].filter((x) => x <= y + 1).length / N, 3: cl >= 3 ? 1 : cross[s.id][3].filter((x) => x <= y + 1).length / N };
      const next = cl >= 3 ? null : cl + 1; out.next = next;
      out.headline = next == null ? null : { toClass: next, by: Math.floor(T1), p: out.byYear[Math.floor(T1)][next], median: out.cross[next].q50, low: out.cross[next].q10, high: out.cross[next].q90 };
      bySegment[s.id] = out;
    }
    const bins = years.map((y) => { const i = stepAt(y); return { year: y, added: Array.from(addSum[i], (v) => +(v / N).toFixed(1)), pStarted: Array.from(startedBy[i], (v) => +(v / N).toFixed(3)) }; });
    return { asOf, to: SEG.day(cfg.to), runs: N, seed: cfg.seed, calibration: +k.toFixed(2), fit: F.summary, hazard: F.hazard, stages: S.bins.map((b) => b.stage), bySegment, bins, years,
      note: 'Chances from ' + N + ' simulated futures. Each step is measured from City of Edmonton records, except apartment move-in time. Blocks next to the line count only as the line itself grows; blocks further off are frozen at today.' };
  }

  // Hindcast: stand at a past date, forecast to a later one with only what was known then, compare with what happened.
  function hindcast(segments, permits, data, opts = {}) {
    const asOf = opts.asOf || '2016-12-31', to = opts.to || '2026-06-30', cutoffYear = +asOf.slice(0, 4);
    const sim = simulate(segments, permits, data, { ...opts, asOf, to, cutoffYear, mode: 'reconstruct', fitted: fit(data, { cutoffYear }) });
    const actual = lineState(segments, permits, null, permits.fetchedAt), lagY = 0.75, T = dy(to);
    const idx = actual.index, nb = actual.nb, W = Math.round(CLASS.DEFAULTS.windowM / DEFAULTS.binM), thr = CLASS.DEFAULTS.thresholds;
    const occAt = (t) => actual.bins.map((b) => Math.max(0, b.roofs - b.permitsToBase) + b.bp.filter((x) => x.t + lagY <= t).reduce((a, x) => a + x.units, 0));
    const classAt = (t) => { const o = occAt(t), pre = [0]; for (const v of o) pre.push(pre[pre.length - 1] + v); const out = {};
      for (const rg of idx.ranges) { let mx = 0; for (let st = Math.max(0, Math.floor((rg.fromM - CLASS.DEFAULTS.windowM) / DEFAULTS.binM) + 1); st * DEFAULTS.binM < rg.toM; st++) mx = Math.max(mx, pre[Math.min(nb, st + W)] - pre[Math.min(nb, st)]); out[rg.id] = mx >= thr.class3 ? 3 : mx >= thr.class2 ? 2 : 1; } return out; };
    const then = classAt(dy(asOf)), at = classAt(T), rows = [];
    let brier = 0, n = 0;
    for (const rg of idx.ranges) for (const c of [2, 3]) { if (then[rg.id] >= c) continue; const p = sim.bySegment[rg.id].byYear[Math.floor(T) - 1] ? sim.bySegment[rg.id].cross[c].samples.filter((x) => x <= T).length / sim.runs : 0, hit = at[rg.id] >= c ? 1 : 0;
      brier += (p - hit) ** 2; n++; if (p >= 0.05 || hit) rows.push({ segment: rg.id, kmFrom: rg.kmFrom, toClass: c, predicted: +p.toFixed(2), happened: !!hit }); }
    const plannedThen = sim.stages.map((s, k) => ({ s, k })).filter((x) => x.s === 'planned');
    const startedNow = (k) => actual.bins[k].start != null && actual.bins[k].start <= T;
    const lastYear = sim.bins[sim.bins.length - 1];
    const binRows = plannedThen.map(({ k }) => ({ bin: k, km: +(k * 0.2).toFixed(1), predicted: lastYear.pStarted[k], started: startedNow(k) }));
    const bBrier = binRows.length ? binRows.reduce((a, x) => a + (x.predicted - (x.started ? 1 : 0)) ** 2, 0) / binRows.length : null;
    const base = binRows.length ? binRows.filter((x) => x.started).length / binRows.length : null;
    return { asOf, to, segmentChanges: rows, segmentBrier: n ? +(brier / n).toFixed(3) : null, segmentsScored: n,
      blocks: { planned: binRows.length, startedSince: binRows.filter((x) => x.started).length, expectedStarts: +binRows.reduce((a, x) => a + x.predicted, 0).toFixed(1), brier: bBrier == null ? null : +bBrier.toFixed(3), baselineBrier: base == null ? null : +(base * (1 - base)).toFixed(3), rows: binRows },
      note: 'Fitted only on years up to ' + cutoffYear + ', from the state of the line on ' + asOf + '. Development permits before 2024 are not in the cache, so approvals do not feed this hindcast. Brier score: 0 is perfect; the baseline is one rate for every block.' };
  }

  const api = { DEFAULTS, BUCKETS, LABEL, rng, dy, iso, fitHazard, fitBuildout, share, sampleHist, fit, lineState, simulate, hindcast };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TC_GROWTH = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
