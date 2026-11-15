#!/usr/bin/env node
// TerraCorridor: fill the corridor_climate_cells cache from YOUR computer (not n8n Cloud).
// Open-Meteo blocks n8n Cloud's shared IP. This script downloads the same two files W2 would,
// runs the SAME condense maths copied verbatim from W2's "Condense Archive" node,
// and writes rows ready to load into the n8n Data Table.
// Needs Node 18 or newer. Usage:  node scripts/fetch-climate-cells.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---- W2 Config values (copied from the W2 export) ----
const BASE_START = '1995-01-01', BASE_END = '2025-12-31';
const PROJ_START = '2026-01-01', PROJ_END = '2035-12-31';
const CLIMATE_MODELS = 'MRI_AGCM3_2_S,EC_Earth3P_HR,MPI_ESM1_2_XR';
const MODELS = CLIMATE_MODELS.split(',').map(s => s.trim()).filter(Boolean);
const SIG = [BASE_START, BASE_END, PROJ_START, PROJ_END, CLIMATE_MODELS, 'v1'].join('|');
const BASE_START_YEAR = 1995, BASE_END_YEAR = 2025;
const HORIZONS = [
  { years: 5, start: '2026', end: String(2026 + 4) },
  { years: 10, start: '2026', end: String(2026 + 9) },
];
// unused by the condense maths but referenced by copied helper functions
const W = { R: 0.35, F: 0.2, W: 0.15, V: 0.2, S: 0.1 }, RATIO_FULL = 0.5, NDVI_FULL = 0.1, SLOPE_FULL = 10, AMBER = 40, RED = 65;
const clamp01 = x => Math.max(0, Math.min(1, x));
const r3 = x => (x === null || x === undefined || !Number.isFinite(x)) ? null : Math.round(x * 1000) / 1000;
const r1 = x => (x === null || x === undefined || !Number.isFinite(x)) ? null : Math.round(x * 10) / 10;

// The 3 grid cells of the demo corridor (from the 8 segments W1 produced)
const CELLS = [
  { cell_key: '53.50_-113.40', lat: 53.5, lon: -113.4 },
  { cell_key: '53.50_-113.30', lat: 53.5, lon: -113.3 },
  { cell_key: '53.60_-113.30', lat: 53.6, lon: -113.3 },
];
const SLEEP_MS = Number(process.env.SLEEP_MS || 65000);
const OUT_DIR = process.env.OUT_DIR || __dirname;

// ---- copied verbatim from W2 "Condense Archive" ----
function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function parseRaw(resp) {
  if (!resp || resp.error || typeof resp.data !== 'string' || !resp.data.length) {
    const e = resp && resp.error;
    return { ok: false, error: (e && (e.message || e.description)) || (typeof e === 'string' ? e : 'request failed or empty response') };
  }
  try {
    const j = JSON.parse(resp.data);
    if (j && j.error === true) return { ok: false, error: j.reason || 'API returned an error' };
    return { ok: true, json: j, hash: resp.raw_hash };
  } catch (e) { return { ok: false, error: 'response is not valid JSON' }; }
}
function tierOf(score) { return score > RED ? 'red' : (score >= AMBER ? 'amber' : 'green'); }
function risk(c) { return 100 * (W.R * c.R + W.F * c.F + W.W * c.W + W.V * c.V + W.S * c.S); }

// Count daily events from parallel arrays, split into a baseline span and projection windows
function seriesMetrics(time, pr, tx, tn, sm, thresholds) {
  // thresholds: {rainP95, soilP90} - if null compute from baseline years
  const idxBase = [];
  for (let i = 0; i < time.length; i++) {
    const y = Number(time[i].slice(0, 4));
    if (y >= BASE_START_YEAR && y <= BASE_END_YEAR) idxBase.push(i);
  }
  const expectedBase = idxBase.length;
  const validBase = idxBase.filter(i => Number.isFinite(pr[i]) && Number.isFinite(tx[i]) && Number.isFinite(tn[i]));
  if (expectedBase < 365 * 10 || validBase.length < 0.95 * expectedBase) return { ok: false, error: 'baseline series incomplete (' + validBase.length + '/' + expectedBase + ' valid days)' };
  const wet = validBase.map(i => pr[i]).filter(v => v >= 1).sort((a, b) => a - b);
  const rainP95 = pct(wet, 0.95);
  const soilVals = sm ? idxBase.map(i => sm[i]).filter(Number.isFinite).sort((a, b) => a - b) : [];
  const soilOk = sm && soilVals.length >= 0.9 * expectedBase;
  const soilP90 = soilOk ? pct(soilVals, 0.9) : null;
  function rates(idx) {
    const n = idx.length; if (!n) return null;
    const v = idx.filter(i => Number.isFinite(pr[i]) && Number.isFinite(tx[i]) && Number.isFinite(tn[i]));
    if (v.length < 0.95 * n) return null;
    const years = v.length / 365.25;
    const rain = v.filter(i => pr[i] > rainP95).length / years;
    const ft = v.filter(i => tn[i] < 0 && tx[i] > 0).length / years;
    let sat = null;
    if (soilOk) {
      const vs = idx.filter(i => Number.isFinite(sm[i]));
      if (vs.length >= 0.9 * n) sat = vs.filter(i => sm[i] > soilP90).length / (vs.length / 365.25);
    }
    return { rain, ft, sat };
  }
  const base = rates(idxBase);
  const windows = {};
  for (const h of HORIZONS) {
    const idx = [];
    for (let i = 0; i < time.length; i++) { const y = time[i].slice(0, 4); if (y >= h.start && y <= h.end) idx.push(i); }
    windows[h.years] = rates(idx);
  }
  return { ok: !!base, error: base ? '' : 'baseline rates unavailable', rainP95, soilP90, base, windows };
}
function ratio(proj, base) {
  if (proj === null || proj === undefined || base === null || base === undefined) return null;
  return Math.min(3, proj / Math.max(base, 0.1));
}


// ---- download helpers ----
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function download(url, label) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'TerraCorridor-laptop-seed/1.0' } });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 200) return buf;
      console.log('  ' + label + ': HTTP ' + res.status + ' ' + buf.toString('utf8').slice(0, 120));
    } catch (e) { console.log('  ' + label + ': ' + e.message); }
    console.log('  waiting ' + Math.round(SLEEP_MS / 1000) + 's then retrying (' + attempt + '/6)');
    await sleep(SLEEP_MS);
  }
  throw new Error(label + ' failed after 6 tries');
}
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// ---- same logic as W2 "Condense Archive" / "Condense Climate" for one cell ----
function condenseArchive(buf) {
  const res = { ok: false, error: '', hash: '' };
  const j = JSON.parse(buf.toString('utf8'));
  if (j && j.error === true) throw new Error(j.reason || 'API returned an error');
  const d = j.daily || {};
  const m = seriesMetrics(d.time || [], d.precipitation_sum || [], d.temperature_2m_max || [], d.temperature_2m_min || [], d.soil_moisture_0_to_7cm_mean || null);
  if (!m.ok) throw new Error(m.error);
  Object.assign(res, { ok: true, rainP95: m.rainP95, soilP90: m.soilP90, base: m.base, fetched_at: new Date().toISOString() });
  res.hash = sha256(buf);
  return res;
}
function condenseClimate(buf) {
  const res = { ok: false, error: '', hash: '', models: {} };
  const j = JSON.parse(buf.toString('utf8'));
  if (j && j.error === true) throw new Error(j.reason || 'API returned an error');
  const d = j.daily || {};
  for (const mdl of MODELS) {
    const m = seriesMetrics(d.time || [], d['precipitation_sum_' + mdl] || [], d['temperature_2m_max_' + mdl] || [], d['temperature_2m_min_' + mdl] || [], d['soil_moisture_0_to_10cm_mean_' + mdl] || null);
    if (!m.ok) { res.models[mdl] = { ok: false, error: m.error }; continue; }
    const r = { ok: true, ratios: {} };
    for (const h of HORIZONS) {
      const w = m.windows[h.years];
      r.ratios[h.years] = w ? { rain: ratio(w.rain, m.base.rain), ft: ratio(w.ft, m.base.ft), sat: m.base.sat === null ? null : ratio(w.sat, m.base.sat) } : null;
    }
    res.models[mdl] = r;
  }
  Object.assign(res, { ok: true, fetched_at: new Date().toISOString() });
  res.hash = sha256(buf);
  return res;
}
function urlsFor(c) {
  return {
    archive_url: 'https://archive-api.open-meteo.com/v1/archive?latitude=' + c.lat + '&longitude=' + c.lon +
      '&start_date=' + BASE_START + '&end_date=' + BASE_END +
      '&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,soil_moisture_0_to_7cm_mean&timezone=UTC',
    climate_url: 'https://climate-api.open-meteo.com/v1/climate?latitude=' + c.lat + '&longitude=' + c.lon +
      '&start_date=' + BASE_START + '&end_date=' + PROJ_END +
      '&models=' + CLIMATE_MODELS +
      '&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,soil_moisture_0_to_10cm_mean',
  };
}
function toRow(c, urls, archive, climate) {
  return {
    cell_key: c.cell_key, cell_lat: c.lat, cell_lon: c.lon, config_signature: SIG,
    archive_hash: archive.hash, climate_hash: climate.hash,
    archive_url: urls.archive_url, climate_url: urls.climate_url,
    archive_metrics_json: JSON.stringify(archive), climate_metrics_json: JSON.stringify(climate),
    fetched_at: new Date().toISOString(),
  };
}
const COLS = ['cell_key', 'cell_lat', 'cell_lon', 'config_signature', 'archive_hash', 'climate_hash', 'archive_url', 'climate_url', 'archive_metrics_json', 'climate_metrics_json', 'fetched_at'];
const csvCell = v => '"' + String(v).replace(/"/g, '""') + '"';
function writeOutputs(rows) {
  const csv = [COLS.join(',')].concat(rows.map(r => COLS.map(k => csvCell(r[k])).join(','))).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT_DIR, 'cache_rows.csv'), csv);
  fs.writeFileSync(path.join(OUT_DIR, 'seed_code_node.js'), '// Paste into an n8n Code node (JavaScript, Run Once for All Items)\nconst ROWS = ' + JSON.stringify(rows, null, 1) + ';\nreturn ROWS.map(r => ({ json: r }));\n');
}

async function main() {
  const rows = [];
  for (let i = 0; i < CELLS.length; i++) {
    const c = CELLS[i];
    const urls = urlsFor(c);
    console.log('Cell ' + (i + 1) + '/' + CELLS.length + ' ' + c.cell_key + ': downloading archive');
    const aBuf = await download(urls.archive_url, 'archive');
    const archive = condenseArchive(aBuf);
    console.log('  archive ok. Waiting ' + Math.round(SLEEP_MS / 1000) + 's (Open-Meteo rate limit)');
    await sleep(SLEEP_MS);
    console.log('Cell ' + (i + 1) + '/' + CELLS.length + ' ' + c.cell_key + ': downloading climate projections');
    const cBuf = await download(urls.climate_url, 'climate');
    const climate = condenseClimate(cBuf);
    console.log('  climate ok');
    rows.push(toRow(c, urls, archive, climate));
    writeOutputs(rows);   // save progress after every cell
    if (i < CELLS.length - 1) { console.log('  waiting before next cell'); await sleep(SLEEP_MS); }
  }
  console.log('\nDONE. Wrote ' + rows.length + ' rows to:\n  ' + path.join(OUT_DIR, 'cache_rows.csv') + '\n  ' + path.join(OUT_DIR, 'seed_code_node.js'));
}
module.exports = { condenseArchive, condenseClimate, urlsFor, toRow, CELLS, SIG };
if (require.main === module) main().catch(e => { console.error('\nFAILED: ' + e.message); process.exit(1); });
