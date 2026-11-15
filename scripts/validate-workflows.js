// Checks every workflow export in workflows/ before it goes into n8n.
//   - valid JSON, connections point at real nodes, $('Node') references point at real nodes
//   - every Code node compiles (wrapped the way n8n wraps it)
//   - Data Table nodes use tables from workflows/wiring.json, and reports the ones still on a SET_ID placeholder
//   - no API keys or bearer tokens pasted into a workflow
// Usage: node scripts/validate-workflows.js          (exit 1 on any error; unset IDs are warnings)
//        node scripts/validate-workflows.js --strict (unset IDs are errors too, use before the demo)
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'workflows');
const wiring = JSON.parse(fs.readFileSync(path.join(dir, 'wiring.json'), 'utf8'));
const strict = process.argv.includes('--strict');
const errors = [], warnings = [];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const secretPatterns = [/Bearer\s+[A-Za-z0-9._-]{20,}/, /sk-[A-Za-z0-9]{20,}/, /eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}/];

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'wiring.json');
const workflowNames = new Set();
for (const f of files) workflowNames.add(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).name);

for (const f of files) {
  const tag = (m) => `${f}: ${m}`;
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  let d;
  try { d = JSON.parse(raw); } catch (e) { errors.push(tag('invalid JSON: ' + e.message)); continue; }
  const names = new Set(d.nodes.map((n) => n.name));
  if (names.size !== d.nodes.length) errors.push(tag('duplicate node names'));
  for (const [src, v] of Object.entries(d.connections || {})) {
    if (!names.has(src)) errors.push(tag(`connection from missing node "${src}"`));
    for (const outs of Object.values(v)) for (const o of outs) for (const c of o || []) if (!names.has(c.node)) errors.push(tag(`"${src}" connects to missing node "${c.node}"`));
  }
  for (const p of secretPatterns) if (p.test(raw)) errors.push(tag('looks like a secret is pasted in (' + p + ')'));
  const unset = new Set();
  for (const n of d.nodes) {
    const params = JSON.stringify(n.parameters || {});
    for (const m of params.matchAll(/\$\(\\?['"]([^'"\\]+)\\?['"]\)/g)) if (!names.has(m[1])) errors.push(tag(`"${n.name}" references missing node "${m[1]}"`));
    const js = n.parameters && n.parameters.jsCode;
    if (js) {
      try { new AsyncFunction('$', '$input', '$json', '$items', '$node', '$now', '$execution', '$env', '$workflow', '$prevNode', '$itemIndex', '$runIndex', '$helpers', 'DateTime', js); }
      catch (e) { errors.push(tag(`Code node "${n.name}" does not compile: ${e.message}`)); }
      for (const m of js.matchAll(/SET_ID_(\w+)/g)) unset.add(m[1]);
      for (const m of js.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)) if (!names.has(m[1])) errors.push(tag(`Code node "${n.name}" references missing node "${m[1]}"`));
    }
    const t = n.parameters && n.parameters.dataTableId;
    if (t && typeof t === 'object' && t.mode === 'id' && !String(t.value).startsWith('=')) {
      if (!(t.cachedResultName in wiring.tables)) errors.push(tag(`"${n.name}" uses table "${t.cachedResultName}" which is not in wiring.json`));
      else if (String(t.value).startsWith('SET_ID_')) unset.add(t.cachedResultName);
      else if (wiring.tables[t.cachedResultName] && t.value !== wiring.tables[t.cachedResultName]) errors.push(tag(`"${n.name}" has table ID ${t.value} but wiring.json says ${wiring.tables[t.cachedResultName]} for ${t.cachedResultName}. Run scripts/wire-workflows.js`));
    }
    if (n.type === 'n8n-nodes-base.executeWorkflow') {
      const w = n.parameters.workflowId || {};
      if (!workflowNames.has(w.cachedResultName) && !(w.cachedResultName in wiring.workflows)) warnings.push(tag(`"${n.name}" calls "${w.cachedResultName}", which is not an export in workflows/`));
      if (!w.value || String(w.value).startsWith('SET_ID_')) unset.add('workflow:' + w.cachedResultName);
    }
  }
  if (unset.size) (strict ? errors : warnings).push(tag('IDs not set yet: ' + [...unset].join(', ')));
  console.log(`${f}: ${d.nodes.length} nodes ok`);
}
warnings.forEach((w) => console.log('WARN  ' + w));
errors.forEach((e) => console.log('ERROR ' + e));
console.log(errors.length ? `${errors.length} error(s)` : 'no errors' + (warnings.length ? `, ${warnings.length} warning(s)` : ''));
process.exit(errors.length ? 1 : 0);
