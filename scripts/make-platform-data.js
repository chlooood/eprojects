// Builds the data the platform page reads, from files already in the repo. No network.
//   data/platform/<corridor>.json           segments (geometry + geohazard result), permits, obligations, sources with hashes
//   data/platform/<corridor>-backtest.json  the class location replay
// Usage: node scripts/make-platform-data.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const CLASS = require('../src/classlocation.js'), OBL = require('../src/obligations.js');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

const corridor = 'ab-strathcona-demo';
const snapshotFile = 'data/snapshot/live-snapshot.json', permitsFile = `data/cache/permits/edmonton-${corridor}.json`, oblFile = 'data/obligations/TEMPLATE.csv';
const snap = read(snapshotFile), permits = read(permitsFile);
const segments = snap.segments.map((s) => ({ id: s.id, kmFrom: s.kmFrom, kmTo: s.kmTo, centreline: s.centreline, risk: { y10: s.risk && s.risk.y10 ? { score: s.risk.y10.score, tier: s.risk.y10.tier, hazard: s.risk.y10.hazard, agreement: s.risk.y10.agreement,
  hazards: s.risk.y10.hazard && s.risk.y10.hazards && s.risk.y10.hazards[s.risk.y10.hazard] ? { [s.risk.y10.hazard]: { why: s.risk.y10.hazards[s.risk.y10.hazard].why } } : {}, drivers: (s.risk.y10.drivers || []).slice(0, 1).map((d) => ({ label: d.label })) } : null }, override: s.override || null }));
const imported = OBL.fromCsv(fs.readFileSync(path.join(root, oblFile), 'utf8'), OBL.DEFAULT_MAPPING, 'invented example rows');
const src = (name, file, extra = {}) => ({ name, file, sha256: sha(file), ...extra });
const doc = {
  meta: { corridorId: corridor, name: 'Edmonton reference corridor', builtAt: permits.fetchedAt,
    route: 'A public OpenStreetMap pipeline way near Edmonton. No operator is involved, and nothing here says this line has a class location obligation.',
    labels: { classLocation: 'REAL open data (City of Edmonton), fetched ' + permits.fetchedAt, geohazard: 'REAL cached run of the existing engine (' + snap.meta.generatedAt.slice(0, 10) + ')', obligations: 'INVENTED example rows', encroachment: 'No feed connected', costs: 'PLACEHOLDER assumptions' } },
  segments, permits, obligations: imported.obligations, encroachmentEvents: null,
  sources: [
    src('Geohazard assessment (existing engine, saved n8n run)', snapshotFile, { fetchedAt: snap.meta.generatedAt.slice(0, 10) }),
    src('City of Edmonton open data: building permits, development permits, rooflines 2019, plans in effect', permitsFile, { fetchedAt: permits.fetchedAt, dataset: [permits.buildingPermits.dataset, permits.developmentPermits.dataset, permits.rooflines.dataset, permits.plans.dataset].join(', '), url: 'https://data.edmonton.ca' }),
    src('Land obligations (invented example rows)', oblFile),
  ],
};
fs.mkdirSync(path.join(root, 'data/platform'), { recursive: true });
fs.writeFileSync(path.join(root, `data/platform/${corridor}.json`), JSON.stringify(doc) + '\n');
const bt = CLASS.backtest(segments, permits, CLASS.DEFAULTS, { to: permits.fetchedAt });
fs.writeFileSync(path.join(root, `data/platform/${corridor}-backtest.json`), JSON.stringify({ corridor, builtFrom: permitsFile, ...bt }, null, 2) + '\n');
console.log(`platform data: ${segments.length} segments, ${imported.obligations.length} obligations (${imported.rejected.length} rejected)`);
console.log(`backtest ${bt.from} to ${bt.to}: ${bt.changes} class changes, ${bt.flaggedAhead} flagged ahead, median lead ${bt.medianLeadMonths} months (assumed construction lag)`);
