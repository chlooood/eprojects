// Writes data/tables/<name>.csv (header plus one typed sample row) and docs/DATA_TABLES.md from the columns the workflows actually write.
// Use the CSVs to create the missing Data tables in n8n: Data tables > Create > Import CSV, then delete the sample row.
// The sample row is there so n8n picks number and date types instead of making every column text.
// Usage: node scripts/tables.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const wdir = path.join(root, 'workflows');
const wiring = JSON.parse(fs.readFileSync(path.join(wdir, 'wiring.json'), 'utf8'));
// W5 picks its tables by expression, so its nodes carry no table name. Map them by node name.
const DYNAMIC = { 'Upsert Build Rows': 'corridor_build', 'Save Assumptions': 'corridor_build_config', 'Save Report (pending_approval)': 'corridor_reports', 'Update Report Decision': 'corridor_reports' };
const WRITERS = {};
const cols = {};
for (const f of fs.readdirSync(wdir).filter((x) => x.endsWith('.json') && x !== 'wiring.json')) {
  const d = JSON.parse(fs.readFileSync(path.join(wdir, f), 'utf8'));
  for (const n of d.nodes) {
    const p = n.parameters || {};
    if (!p.dataTableId || p.operation === 'get') continue;
    const name = (p.dataTableId && p.dataTableId.cachedResultName) || DYNAMIC[n.name];
    if (!name || !(name in wiring.tables)) continue;
    const c = p.columns || {};
    const types = Object.fromEntries((c.schema || []).map((s) => [s.id, s.type || 'string']));
    cols[name] = cols[name] || {};
    for (const k of Object.keys(c.value || {})) cols[name][k] = cols[name][k] || types[k] || 'string';
    (WRITERS[name] = WRITERS[name] || new Set()).add(`${d.name.replace(/^TerraCorridor /, '')} / ${n.name}`);
  }
}
const sample = { string: 'sample', number: '1', dateTime: '2026-11-14T12:00:00.000Z', boolean: 'true' };
fs.mkdirSync(path.join(root, 'data', 'tables'), { recursive: true });
const md = ['# Data tables', '',
  'All workflows share these n8n Data tables. W1 and W2 already have theirs. The rest must exist in the same n8n instance before the other workflows can run.',
  'Create a missing one with Data tables > Create > Import CSV and the file in `data/tables/`, then delete the sample row. Copy each table ID from the URL into `workflows/wiring.json`, run `node scripts/wire-workflows.js`, then import.',
  '', '| Table | Written by | Columns |', '| --- | --- | --- |'];
for (const name of Object.keys(wiring.tables)) {
  const c = cols[name];
  if (!c) { md.push(`| \`${name}\` | W2 climate cache (laptop script or W2) | see the W2 export |`); continue; }
  if (name === 'corridor_segments' || name === 'corridor_baselines' || name === 'corridor_predictions' || name === 'corridor_sources' || name === 'corridor_climate_cells') {
    md.push(`| \`${name}\` | ${[...WRITERS[name]].join('; ')} | ${Object.keys(c).length} columns, already exists |`);
    continue;
  }
  const keys = Object.keys(c);
  fs.writeFileSync(path.join(root, 'data', 'tables', name + '.csv'), keys.join(',') + '\n' + keys.map((k) => sample[c[k]] || 'sample').join(',') + '\n');
  md.push(`| \`${name}\` | ${[...WRITERS[name]].join('; ')} | ${keys.map((k) => `${k} (${c[k]})`).join(', ')} |`);
}
fs.writeFileSync(path.join(root, 'docs', 'DATA_TABLES.md'), md.join('\n') + '\n');
console.log('data/tables/*.csv and docs/DATA_TABLES.md written');
