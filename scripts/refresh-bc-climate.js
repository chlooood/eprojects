#!/usr/bin/env node
// One command to refresh the Coquihalla (BC) climate cell and rescore BC on the current W2 windows.
// Run from a network that Open-Meteo has not rate-limited today (about 5 large cells per IP per day).
//   npm run refresh-bc-climate
// Steps: download cell 49.40_-121.30 with scripts/fetch-climate-cells.js (W2's own condense code),
// move that row out of the Edmonton cache into data/corridors/bc-coquihalla/climate-cells.json,
// then run prepare-bc (rescoring with the unmodified W2 thresholds) and rebuild the seed and pages.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const CELL = '49.40_-121.30';
const EDM = path.join(ROOT, 'data', 'cache', 'cells', 'trans-northern-cells.json');
const BC = path.join(ROOT, 'data', 'corridors', 'bc-coquihalla', 'climate-cells.json');
const run = (args) => execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, SLEEP_MS: process.env.SLEEP_MS || '5000' } });

const before = fs.readFileSync(EDM, 'utf8');
try {
  run([path.join('scripts', 'fetch-climate-cells.js'), CELL]);
} catch (e) {
  fs.writeFileSync(EDM, before);
  console.error('\nDownload failed (usually the Open-Meteo request limit). Nothing was changed. Try again later or from another network.');
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(EDM, 'utf8'));
const row = rows.find((r) => r.cell_key === CELL);
fs.writeFileSync(EDM, before);   // the Edmonton cache is left exactly as it was
if (!row || !/\|v3$/.test(row.config_signature)) { console.error('No v3 row for ' + CELL + ' was produced.'); process.exit(1); }
fs.writeFileSync(BC, JSON.stringify([row], null, 1) + '\n');
console.log('\nWrote ' + path.relative(ROOT, BC) + ' (' + row.config_signature.split('|').pop() + ', fetched ' + row.fetched_at + ')');
run([path.join('scripts', 'prepare-bc-corridor.js')]);
run([path.join('scripts', 'make-bc-seed.js')]);
run([path.join('scripts', 'verify-bc-inputs.js'), '--record']);
run([path.join('scripts', 'build.js')]);
run([path.join('scripts', 'make-api-workflow.js')]);
const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'corridors', 'bc-coquihalla', 'verification.json'), 'utf8'));
console.log('\nBC tiers on the new windows: ' + JSON.stringify(v.tiers));
console.log('Next: npm test, then commit and push (see docs/BC_CORRIDOR.md).');
