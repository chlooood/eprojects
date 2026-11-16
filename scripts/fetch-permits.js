#!/usr/bin/env node
// TerraCorridor: class location inputs for one municipality, from YOUR computer. Free open data, no key.
// Like fetch-crossings.js, this runs on a laptop because shared cloud IPs are often refused.
//   1. reads the segments from the dashboard feed (GET {API}/corridor) or a saved corridor JSON
//   2. City of Edmonton open data (Socrata): building permits that add dwelling units, development permits,
//      the 2019 roofline survey, and plans in effect
//   3. keeps what lies within 200 m of the centreline and bins it by 200 m of chainage
// Output: data/cache/permits/edmonton-<corridor>.json (compact, committed) and ...-raw.json (every row in the box; gitignored).
// Usage: node scripts/fetch-permits.js data/snapshot/live-snapshot.json
//        node scripts/fetch-permits.js https://YOUR-INSTANCE.app.n8n.cloud/webhook/terracorridor
// Another municipality: copy this file and change DATASETS and the field names. Most Canadian and US cities publish
// permits on Socrata, ArcGIS Hub or CKAN; the compact format is the same.
const fs = require('fs');
const path = require('path');
const SEG = require('../src/segments.js');
const HOST = 'https://data.edmonton.ca/resource/';
const DATASETS = { buildingPermits: '24uj-dj8v', developmentPermits: '2ccn-pwtu', rooflines: 'jpxi-a9a5', plans: 'jdmr-bidz' };
const BAND_M = 200, BIN_M = 200, DEV_SINCE = '2024-01-01', MIN_ROOF_M2 = 60, TALL_M = 12;

const src = process.argv[2];
if (!src) { console.error('Give the API base URL or a saved corridor JSON file.'); process.exit(1); }
const get = async (dataset, params) => {
  const url = HOST + dataset + '.json?' + new URLSearchParams(params);
  const res = await fetch(url, { headers: { 'User-Agent': 'TerraCorridor-laptop-seed/1.0' } });
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(dataset + ': ' + JSON.stringify(rows).slice(0, 200));
  return rows;
};
const quarter = (iso) => iso.slice(0, 4) + 'Q' + (Math.floor((+iso.slice(5, 7) - 1) / 3) + 1);
const typeCode = (t) => (String(t || '').match(/\((\d+)\)/) || [])[1] || '';
const dwellings = (d) => { const m = String(d || '').match(/(\d+)\s*(?:principal\s+)?dwelling/i); return m ? +m[1] : /semi-detached/i.test(d) ? 2 : /(single detached|backyard) house/i.test(d) ? 1 : null; };

async function main() {
  const corridor = /^https?:/.test(src) ? await (await fetch(src.replace(/\/$/, '') + '/corridor')).json() : JSON.parse(fs.readFileSync(src, 'utf8'));
  const id = (corridor.meta && corridor.meta.corridorId) || 'corridor';
  const index = SEG.buildIndex(corridor.segments);
  const pts = corridor.segments.flatMap((s) => s.centreline || []);
  const pad = 0.004, lo = (i) => (Math.min(...pts.map((p) => p[i])) - pad).toFixed(4), hi = (i) => (Math.max(...pts.map((p) => p[i])) + pad).toFixed(4);
  const box = `latitude > '${lo(1)}' AND latitude < '${hi(1)}' AND longitude > '${lo(0)}' AND longitude < '${hi(0)}'`;
  const near = (lon, lat) => { const at = SEG.locate(index, [+lon, +lat]); return at.offsetM <= BAND_M ? at : null; };
  const compact = (rows, unitsOf, idOf, dateOf, codeOf, noteOf) => {
    const large = [], cells = {}; let matched = 0, units = 0;
    for (const r of rows) {
      const at = r.latitude && near(r.longitude, r.latitude), u = unitsOf(r);
      if (!at || !u) continue;
      matched++; units += u;
      const date = String(dateOf(r) || '').slice(0, 10);
      if (u >= 5) large.push([idOf(r), date, u, codeOf(r), Math.round(at.chainageM), ...(noteOf ? [noteOf(r)] : [])]);
      else { const k = Math.floor(at.chainageM / BIN_M) + ',' + quarter(date); const c = cells[k] || (cells[k] = [0, 0]); c[0]++; c[1] += u; }
    }
    return { rowsInBox: rows.length, matched, units, large: large.sort((a, b) => a[1].localeCompare(b[1])),
      cells: Object.entries(cells).map(([k, v]) => `${k},${v[0]},${v[1]}`).sort((a, b) => +a.split(',')[0] - +b.split(',')[0] || a.split(',')[1].localeCompare(b.split(',')[1])).join(';') };
  };

  console.log('building permits...');
  const bpRows = await get(DATASETS.buildingPermits, { $select: 'row_id,issue_date,units_added,building_type,latitude,longitude', $where: 'units_added > 0 AND ' + box, $limit: 50000 });
  const bp = compact(bpRows, (r) => +r.units_added, (r) => r.row_id, (r) => r.issue_date, (r) => typeCode(r.building_type));
  console.log('development permits...');
  const devRows = (await get(DATASETS.developmentPermits, { $select: 'city_file_number,permit_date,status,description_of_development,latitude,longitude', $where: `permit_date >= '${DEV_SINCE}' AND ` + box, $limit: 50000 }))
    .filter((r) => /construct/i.test(r.description_of_development || '') && !/exterior alterations/i.test(r.description_of_development || ''));
  const dev = compact(devRows, (r) => dwellings(r.description_of_development), (r) => r.city_file_number, (r) => r.permit_date, () => 'cluster', (r) => String(r.description_of_development).replace(/\s+/g, ' ').slice(0, 110));

  console.log('rooflines (2019 baseline)...');
  const roofs = {}, tall = {}, seen = new Set(); let fetched = 0, matched = 0;
  for (let i = 0; i < pts.length - 1; i += 6) {
    const part = pts.slice(i, i + 7), x0 = Math.min(...part.map((p) => p[0])) - 0.0035, x1 = Math.max(...part.map((p) => p[0])) + 0.0035, y0 = Math.min(...part.map((p) => p[1])) - 0.0021, y1 = Math.max(...part.map((p) => p[1])) + 0.0021;
    const rows = await get(DATASETS.rooflines, { $select: 'area,building_height,the_geom', $where: `intersects(the_geom, 'POLYGON((${x0} ${y0}, ${x1} ${y0}, ${x1} ${y1}, ${x0} ${y1}, ${x0} ${y0}))')`, $limit: 40000 });
    for (const r of rows) {
      fetched++;
      const ring = r.the_geom && (r.the_geom.type === 'MultiPolygon' ? r.the_geom.coordinates[0][0] : r.the_geom.coordinates[0]);
      if (!ring || !(+r.area >= MIN_ROOF_M2)) continue;
      const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length, cy = ring.reduce((a, p) => a + p[1], 0) / ring.length, key = cx.toFixed(6) + ',' + cy.toFixed(6);
      if (seen.has(key)) continue; seen.add(key);
      const at = near(cx, cy); if (!at) continue;
      matched++; const k = Math.floor(at.chainageM / BIN_M); roofs[k] = (roofs[k] || 0) + 1; if (+r.building_height >= TALL_M) tall[k] = (tall[k] || 0) + 1;
    }
  }
  const cellText = (o) => Object.entries(o).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => `${k}:${v}`).join(',');

  console.log('plans in effect...');
  const plans = {};
  for (let i = 0; i < pts.length; i += 4) {
    const km = Math.round(SEG.locate(index, pts[i]).chainageM / 100) / 10;
    for (const r of await get(DATASETS.plans, { $select: 'plan_in_effect_name,plan_in_effect_type_descr,bylaw_no,pdf_url', $where: `intersects(geometry, 'POINT(${pts[i][0]} ${pts[i][1]})')`, $limit: 20 })) {
      const p = plans[r.plan_in_effect_name] || (plans[r.plan_in_effect_name] = { name: r.plan_in_effect_name, type: r.plan_in_effect_type_descr, bylaw: r.bylaw_no || '', kmFrom: km, kmTo: km, pdf: (r.pdf_url && r.pdf_url.url) || r.pdf_url || '' });
      p.kmFrom = Math.min(p.kmFrom, km); p.kmTo = Math.max(p.kmTo, km);
    }
  }

  const today = new Date().toISOString().slice(0, 10), url = (d) => HOST + d + '.json';
  const out = { corridor: id, municipality: 'City of Edmonton', fetchedAt: today,
    licence: 'City of Edmonton Open Data Terms of Use (free, open). Contains information licensed under the Open Government Licence - City of Edmonton.',
    method: `scripts/fetch-permits.js on ${today}: records within ${BAND_M} m of the centreline, binned by ${BIN_M} m of chainage. Permits adding 5 or more units are kept one by one.`,
    binM: BIN_M, bandM: BAND_M,
    buildingPermits: { dataset: DATASETS.buildingPermits, name: 'General Building Permits', url: url(DATASETS.buildingPermits), rowsInBox: bp.rowsInBox, matched: bp.matched, unitsAdded: bp.units, large: bp.large, cells: bp.cells },
    developmentPermits: { dataset: DATASETS.developmentPermits, name: 'Development Permits', url: url(DATASETS.developmentPermits), since: DEV_SINCE, rowsInBox: dev.rowsInBox, matched: dev.matched, large: dev.large, cells: dev.cells },
    rooflines: { dataset: DATASETS.rooflines, name: 'City of Edmonton - Rooflines (as of 2019)', url: url(DATASETS.rooflines), asOf: '2019-12-31', minAreaM2: MIN_ROOF_M2, fetched, matched, cells: cellText(roofs), tallCells: cellText(tall) },
    plans: { dataset: DATASETS.plans, name: 'Plans in Effect', url: url(DATASETS.plans), rows: Object.values(plans) } };
  const dir = path.join(__dirname, '..', 'data', 'cache', 'permits');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `edmonton-${id}.json`), JSON.stringify(out, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, `edmonton-${id}-raw.json`), JSON.stringify({ fetchedAt: today, buildingPermits: bpRows, developmentPermits: devRows }) + '\n');
  console.log(`saved: ${bp.matched} building permits (${bp.units} units), ${dev.matched} development permits, ${matched} roofs, ${Object.keys(plans).length} plans.`);
  console.log('Next: npm run build   (rebuilds the platform data, the replay and the pages)');
}
main().catch((e) => { console.error('Failed: ' + e.message + '\nNothing was saved. The existing cache is unchanged.'); process.exit(1); });
