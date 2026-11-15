// Browser checks for deploy/renewables.html: pipeline filter, solar/wind layer switching, detail view,
// missing-data labelling, CSV export, mobile layout. Runs offline from the built file (tiles are blocked).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
async function main() {
  const file = 'file://' + path.join(root, 'deploy/renewables.html');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 860 } });
    await ctx.route(/^https?:/, (r) => r.abort());
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(file);
    await page.locator('#candList button').first().waitFor();
    const state = () => page.evaluate(() => ({ p: window.TC_RENEWABLES_STATE.pipeline, l: window.TC_RENEWABLES_STATE.layer }));
    assert.deepEqual(await state(), { p: 'ab-strathcona-demo', l: 'solar' });
    const techs = async () => page.$$eval('#candList button b', (bs) => [...new Set(bs.map((b) => b.textContent.split(' ')[0]))]);
    assert.deepEqual(await techs(), ['Solar']);
    await page.click('#layerSeg button[data-layer="wind"]');
    assert.deepEqual(await techs(), ['Wind']);
    await page.click('#layerSeg button[data-layer="both"]');
    assert.deepEqual((await techs()).sort(), ['Solar', 'Wind']);
    assert.match(page.url(), /layer=both/);
    // pipeline filter
    await page.selectOption('#pipelineSel', 'bc-coquihalla');
    assert.equal((await state()).p, 'bc-coquihalla');
    const bcItems = await page.$$eval('#candList button', (b) => b.map((x) => x.dataset.id));
    assert.ok(bcItems.length > 0 && bcItems.every((id) => id.startsWith('rn_bc-coquihalla_')), 'only Coquihalla candidates listed');
    await page.selectOption('#pipelineSel', 'all');
    const allItems = await page.$$eval('#candList button', (b) => b.map((x) => x.dataset.id));
    assert.ok(allItems.some((id) => id.startsWith('rn_bc-coquihalla_')) && allItems.some((id) => id.startsWith('rn_ab-strathcona-demo_')));
    await page.selectOption('#pipelineSel', 'ab-strathcona-demo');
    // detail view shows factors, coverage and gates
    await page.locator('#candList button').first().click();
    await page.getByText('How the score is made').waitFor();
    const detail = await page.textContent('#panel');
    assert.match(detail, /of the inputs/); assert.match(detail, /Not checked here/); assert.doesNotMatch(detail, /\bfeasible\b/i);
    // status filter: hide excluded
    await page.click('#tabs button[data-tab="summary"]');
    await page.uncheck('#statusChips input[value="excluded"]');
    const statuses = await page.$$eval('#candList .status', (s) => s.map((x) => x.textContent));
    assert.ok(!statuses.includes('Ruled out'));
    // money recompute
    await page.click('#tabs button[data-tab="money"]');
    const before = await page.textContent('#panel');
    await page.fill('input[data-path="priceCadPerMwh"]', '120'); await page.dispatchEvent('input[data-path="priceCadPerMwh"]', 'change');
    const after = await page.textContent('#panel');
    assert.notEqual(before, after, 'changing the price recomputes the scenario');
    // CSV export
    await page.click('#tabs button[data-tab="table"]');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#csvBtn')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    assert.ok(csv.startsWith('id,corridorId,tech')); assert.ok(csv.trim().split('\n').length > 2);
    // sources
    await page.click('#tabs button[data-tab="sources"]');
    assert.match(await page.textContent('#panel'), /Global Wind Atlas/);
    // deep link keeps pipeline, layer and selection
    const id = allItems.find((x) => x.startsWith('rn_bc-coquihalla_') && x.includes('_wind_'));
    await page.goto(file + '?pipeline=bc-coquihalla&layer=solar#' + encodeURIComponent(id));
    await page.getByText('How the score is made').waitFor();
    assert.equal((await state()).l, 'wind', 'deep link switches to the selected candidate layer');
    // mobile
    const m = await browser.newContext({ viewport: { width: 390, height: 844 } }); await m.route(/^https?:/, (r) => r.abort());
    const mp = await m.newPage(); mp.on('pageerror', (e) => errors.push(e.message)); await mp.goto(file);
    await mp.locator('#candList button').first().waitFor();
    const box = await mp.locator('#map').boundingBox(); assert.ok(box.width <= 390 && box.height > 300, 'map is full width and tall on mobile');
    const sw = await mp.evaluate(() => document.documentElement.scrollWidth); assert.ok(sw <= 400, 'no horizontal overflow on mobile: ' + sw);
    assert.deepEqual(errors, []);
    console.log('renewables browser checks passed');
  } finally { await browser.close(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
