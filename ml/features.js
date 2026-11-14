// Build the ML training table from PHMSA hazardous liquid accident data.
// Run on a teammate's laptop (phmsa.dot.gov blocks our cloud workspace, and Open-Meteo's free
// limit is per IP). Resumable: every API response is cached in ml/cache/.
//
// 1. Download "Hazardous Liquid Accident Data - January 2010 to present (ZIP)" from
//    https://www.phmsa.dot.gov/data-and-statistics/pipeline/distribution-transmission-gathering-lng-and-liquid-accident-and-incident-data
//    and unzip the data .txt (tab-delimited) into ml/raw/.
// 2. node ml/features.js ml/raw/<file>.txt [--max-controls 600]
// 3. python ml/train.py
//
// Label: 1 = onshore accident caused by natural force damage, 0 = onshore accident with another cause.
// Both sets sit on real pipelines, so no national pipeline map is needed (case-control design).
// Features mirror the live engine factors, so the learned coefficients drop straight into 05-score.js:
//   rain, freezeThaw, saturation = change ratio, last 5 years before the accident vs the 20 years before that
//   slope = grade (%) from elevations 200 m either side, scaled like the engine
const fs = require('fs');
const path = require('path');
const E = require('../src/engine.js');

const file = process.argv[2];
const maxControls = +(process.argv[process.argv.indexOf('--max-controls') + 1] || 600);
if (!file) { console.error('usage: node ml/features.js <phmsa_hl_file.txt> [--max-controls 600]'); process.exit(1); }
const CACHE = path.join(__dirname, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split('\t').map((h) => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map((l) => { const c = l.split('\t'); const o = {}; head.forEach((h, i) => (o[h] = (c[i] || '').trim().replace(/^"|"$/g, ''))); return o; });
}
const pick = (row, ...needles) => {
  for (const n of needles) { const k = Object.keys(row).find((k) => k.toUpperCase().includes(n)); if (k && row[k]) return row[k]; }
  return '';
};

async function cachedJson(url, name) {
  const f = path.join(CACHE, name);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({ error: true, reason: 'bad json' }));
    if (!j.error) { fs.writeFileSync(f, JSON.stringify(j)); return j; }
    if (/limit/i.test(j.reason || '')) throw new Error('Open-Meteo limit hit: ' + j.reason + ' (rerun tomorrow or from another network; cache keeps progress)');
    await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
  }
  throw new Error('failed ' + url);
}

(async () => {
  const rows = parseTsv(fs.readFileSync(file, 'latin1'));
  const recs = rows.map((r) => ({
    id: pick(r, 'REPORT_NUMBER', 'RPTID') || Math.random().toString(36).slice(2),
    lat: +pick(r, 'LOCATION_LATITUDE', 'LATITUDE'),
    lon: +pick(r, 'LOCATION_LONGITUDE', 'LONGITUDE'),
    date: (pick(r, 'LOCAL_DATETIME', 'ACCIDENT_DATE', 'IDATE') || '').slice(0, 10),
    cause: pick(r, 'CAUSE').toUpperCase(),
    detail: pick(r, 'CAUSE_DETAILS', 'SUBCAUSE').toUpperCase(),
    offshore: /OFF/i.test(pick(r, 'ON_OFF_SHORE', 'OFFSHORE')),
  })).filter((r) => r.lat && r.lon && !r.offshore && r.date);

  // Normalise dates like 1/31/2015 to 2015-01-31
  for (const r of recs) if (!/^\d{4}-/.test(r.date)) { const m = r.date.match(/(\d+)\/(\d+)\/(\d{4})/); if (m) r.date = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  const usable = recs.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && +r.date.slice(0, 4) >= 2010);
  const positives = usable.filter((r) => r.cause.includes('NATURAL FORCE'));
  let controls = usable.filter((r) => !r.cause.includes('NATURAL FORCE'));
  // Deterministic sample of controls
  controls = controls.sort((a, b) => (a.id > b.id ? 1 : -1)).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / maxControls)) === 0).slice(0, maxControls);
  console.log(`onshore records ${usable.length}, natural force ${positives.length}, controls ${controls.length}`);

  const out = [['id', 'label', 'lat', 'lon', 'date', 'cause_detail', 'rain', 'freezeThaw', 'saturation', 'slope', 'slopePct']];
  const all = [...positives.map((r) => ({ ...r, label: 1 })), ...controls.map((r) => ({ ...r, label: 0 }))];
  let done = 0;
  for (const r of all) {
    const y = +r.date.slice(0, 4);
    const lat = r.lat.toFixed(3), lon = r.lon.toFixed(3);
    try {
      const daily = (await cachedJson(
        `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${y - 25}-01-01&end_date=${y - 1}-12-31&daily=precipitation_sum,temperature_2m_min,temperature_2m_max,soil_moisture_0_to_7cm_mean&timezone=UTC`,
        `arch_${lat}_${lon}_${y}.json`)).daily;
      const base = E.baselineStats(E.sliceYears(daily, y - 25, y - 6));
      const recent = E.projectedStats({ obs: daily }, base, [y - 5, y - 1]).obs;
      const ratio = (a, b) => (a == null || b == null ? null : b === 0 ? (a > 0 ? 2 : 1) : a / b);
      const f = (x) => (x == null ? '' : Math.max(0, Math.min(1, x - 1)).toFixed(4));
      // slope from 3 elevations along a 400 m north-south line (pipeline bearing is unknown)
      const dLat = 200 / 111320;
      const elev = (await cachedJson(`https://api.open-meteo.com/v1/elevation?latitude=${(r.lat - dLat).toFixed(5)},${r.lat.toFixed(5)},${(r.lat + dLat).toFixed(5)}&longitude=${r.lon},${r.lon},${r.lon}`, `elev_${lat}_${lon}.json`)).elevation;
      const slopePct = elev && elev.length === 3 ? Math.max(Math.abs(elev[1] - elev[0]), Math.abs(elev[2] - elev[1])) / 200 * 100 : null;
      out.push([r.id, r.label, r.lat, r.lon, r.date, `"${r.detail.replace(/"/g, '')}"`,
        f(ratio(recent.extremeDaysPerYr, base.extremeDaysPerYr)), f(ratio(recent.freezeThawDaysPerYr, base.freezeThawDaysPerYr)),
        f(ratio(recent.wetSoilDaysPerYr, base.wetSoilDaysPerYr)), slopePct == null ? '' : Math.min(1, slopePct / 15).toFixed(4), slopePct == null ? '' : slopePct.toFixed(2)]);
    } catch (e) {
      console.error(r.id, e.message);
      if (/limit hit/.test(e.message)) break;
    }
    if (++done % 25 === 0) console.log(`${done}/${all.length}`);
  }
  fs.writeFileSync(path.join(__dirname, 'features.csv'), out.map((r) => r.join(',')).join('\n'));
  console.log(`wrote ml/features.csv with ${out.length - 1} rows`);
})();
