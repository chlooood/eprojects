// Generates workflows/TerraCorridor API - Dashboard feed.json, the workflow that answers the dashboard.
//   GET /webhook/terracorridor/corridor  reads the Data Tables W1, W2, W3, W4 and W5 write and returns the JSON the dashboard reads.
// The dashboard's POST /terracorridor/action is answered by WF4 (already in workflows/), not here.
// The Code node body is src/dashboard-api.js pasted in whole, so the tested function is the one n8n runs.
// Usage: node scripts/make-api-workflow.js   (run scripts/wire-workflows.js after it to fill in table IDs)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const wiring = JSON.parse(fs.readFileSync(path.join(root, 'workflows', 'wiring.json'), 'utf8'));
const src = fs.readFileSync(path.join(root, 'src', 'dashboard-api.js'), 'utf8').replace(/if \(typeof module[\s\S]*$/, '').trimEnd();
const uuid = (s) => { const h = crypto.createHash('sha1').update('terracorridor-api|' + s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const tref = (name) => ({ __rl: true, mode: 'id', value: wiring.tables[name] || 'SET_ID_' + name, cachedResultName: name });

const HOOK = 'GET /terracorridor/corridor';
const reads = [
  ['Get segments', 'corridor_segments'], ['Get baselines', 'corridor_baselines'], ['Get predictions', 'corridor_predictions'],
  ['Get build', 'corridor_build'], ['Get build config', 'corridor_build_config'], ['Get watch state', 'corridor_watch'], ['Get work orders', 'corridor_work_orders'], ['Get audit', 'corridor_audit'], ['Get corridor sources', 'corridor_sources'],
];
const code = `${src}

// ---- n8n wrapper. A missing or empty table gives an empty list, so the dashboard still loads and shows those segments as unverified.
const rows = (name) => { try { return $(name).all().map((i) => i.json).filter((j) => j && !j.error); } catch (e) { return []; } };
const q = $('${HOOK}').first().json.query || {};
return [{ json: buildCorridor({
  segments: rows('Get segments'), baselines: rows('Get baselines'), predictions: rows('Get predictions'), build: rows('Get build'),
  buildConfig: rows('Get build config'), watch: rows('Get watch state'), workOrders: rows('Get work orders'), audit: rows('Get audit'), sources: rows('Get corridor sources'),
}, { corridorId: q.corridor || undefined, name: q.name || undefined }) }];
`;

const nodes = [{
  parameters: { httpMethod: 'GET', path: 'terracorridor/corridor', responseMode: 'responseNode', options: { allowedOrigins: '*' } },
  id: uuid(HOOK), name: HOOK, type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0, 0], webhookId: uuid('webhook'),
}];
reads.forEach(([name, table], i) => nodes.push({
  parameters: { operation: 'get', dataTableId: tref(table), returnAll: true },
  id: uuid(name), name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, position: [240 + i * 220, 0],
  executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput',
}));
nodes.push({
  parameters: { jsCode: code }, id: uuid('code'), name: 'Build dashboard JSON', type: 'n8n-nodes-base.code', typeVersion: 2, position: [240 + reads.length * 220, 0],
});
nodes.push({
  parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: { responseCode: 200 } },
  id: uuid('respond'), name: 'Respond corridor', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4, position: [240 + (reads.length + 1) * 220, 0],
});
const chain = [HOOK, ...reads.map((r) => r[0]), 'Build dashboard JSON', 'Respond corridor'];
const connections = {};
for (let i = 0; i < chain.length - 1; i++) connections[chain[i]] = { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] };

const wf = { name: 'TerraCorridor API - Dashboard feed', nodes, connections, pinData: {}, active: false, settings: { executionOrder: 'v1' }, tags: [] };
const out = path.join(root, 'workflows', 'TerraCorridor API - Dashboard feed.json');
fs.writeFileSync(out, JSON.stringify(wf, null, 2));
console.log(`${path.relative(root, out)}: ${nodes.length} nodes`);
