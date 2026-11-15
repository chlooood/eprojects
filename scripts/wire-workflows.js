// Points every workflow in workflows/ at YOUR n8n instance's Data Tables and workflows, by name.
// Why: the exports came from three different n8n instances, so the IDs inside them mean nothing to each other.
// Fill in workflows/wiring.json (IDs are in the n8n URL), run this, then import the JSON files.
// Usage: node scripts/wire-workflows.js            apply wiring.json to every workflow
//        node scripts/wire-workflows.js --dry-run  show what would change
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'workflows');
const dry = process.argv.includes('--dry-run');
const wiring = JSON.parse(fs.readFileSync(path.join(dir, 'wiring.json'), 'utf8'));
const tid = (name) => wiring.tables[name] || 'SET_ID_' + name;
const wid = (name) => wiring.workflows[name] || 'SET_ID_' + name.replace(/[^A-Za-z0-9]+/g, '_');
// W5 keeps its table IDs in a shared code block instead of in node parameters.
const PRELUDE = { segmentsTable: 'corridor_segments', predictionsTable: 'corridor_predictions', baselinesTable: 'corridor_baselines',
  alertsTable: 'corridor_watch', auditTable: 'corridor_work_orders', buildTable: 'corridor_build', reportsTable: 'corridor_reports', configTable: 'corridor_build_config' };

let changedFiles = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'wiring.json')) {
  const file = path.join(dir, f);
  const raw = fs.readFileSync(file, 'utf8');
  const d = JSON.parse(raw);
  const log = [];
  for (const n of d.nodes) {
    const p = n.parameters || {};
    const t = p.dataTableId;
    if (t && typeof t === 'object' && t.mode === 'id' && !String(t.value).startsWith('=') && t.cachedResultName in wiring.tables) {
      const want = tid(t.cachedResultName);
      if (t.value !== want) { log.push(`${n.name}: ${t.cachedResultName} -> ${want}`); t.value = want; }
    }
    if (n.type === 'n8n-nodes-base.executeWorkflow' && p.workflowId && p.workflowId.cachedResultName in wiring.workflows) {
      const w = p.workflowId, want = wid(w.cachedResultName);
      if (w.value !== want) { log.push(`${n.name}: workflow ${w.cachedResultName} -> ${want}`); w.value = want; }
    }
    if (typeof p.jsCode === 'string' && p.jsCode.includes('const integrations')) {
      for (const [key, table] of Object.entries(PRELUDE)) {
        const re = new RegExp(`(\\b${key}:\\s*")([^"]*)(")`);
        const m = p.jsCode.match(re);
        if (m && m[2] !== tid(table)) { p.jsCode = p.jsCode.replace(re, `$1${tid(table)}$3`); log.push(`${n.name}: ${key} -> ${tid(table)}`); }
      }
    }
  }
  if (log.length) {
    changedFiles++;
    console.log(`${f}: ${log.length} change(s)`);
    if (dry) log.slice(0, 40).forEach((l) => console.log('   ' + l));
    else fs.writeFileSync(file, JSON.stringify(d, null, 2));
  }
}
console.log(changedFiles ? (dry ? 'dry run, nothing written' : `wired ${changedFiles} file(s)`) : 'already wired, nothing to change');
const missing = Object.entries(wiring.tables).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) console.log('Still need an ID in wiring.json for: ' + missing.join(', '));
