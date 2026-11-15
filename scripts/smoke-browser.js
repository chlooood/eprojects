// Reproducible browser checks. Does not create live work orders; /action is mocked here.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
async function main() {
 const feed = JSON.parse(fs.readFileSync(path.join(root,'data/snapshot/live-snapshot.json')));
 const target = feed.segments.find(s => !s.workOrder).id;
 const server = http.createServer((req,res)=> {
  if(req.url.startsWith('/api/corridor')) {res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(feed));}
  const file = req.url.split('?')[0] === '/sw.js' ? 'sw.js' : 'index.html';
  res.setHeader('Content-Type', file.endsWith('.js')?'application/javascript':'text/html');
  res.end(fs.readFileSync(path.join(root,'deploy',file)));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),args:['--no-sandbox']});
 try {
  const context=await browser.newContext({acceptDownloads:true});
  const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/action',route=>route.fulfill({status:502,contentType:'application/json',body:'{"ok":false,"error":"test outage"}'}));
  await page.goto(base+'/?api='+encodeURIComponent(base+'/api')+'&corridor=ab-strathcona-demo#/segment/'+target);
  await page.locator('[data-act="approved"]').first().waitFor();
  await page.locator('[data-act="approved"]').first().click();
  await page.getByText('Retry inspection approval',{exact:true}).first().waitFor();
  await page.unroute('**/action');
  await page.route('**/action',route=>route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"status":"approved","work_order_id":"WO-BROWSER-TEST"}'}));
  await page.getByText('Retry inspection approval',{exact:true}).first().click();
  await page.getByText('✓ Approved · recorded in n8n',{exact:true}).first().waitFor();
  await page.goto(base+'/?api='+encodeURIComponent(base+'/api')+'&corridor=ab-strathcona-demo#/log');
  await page.locator('#bCsv:not([disabled])').waitFor();
  const [dl]=await Promise.all([page.waitForEvent('download'),page.locator('#bCsv').click()]);
  const csv=fs.readFileSync(await dl.path(),'utf8');assert.match(csv,/work_order|recordedIn/);assert.match(csv,/WO-/);
  // Wait for the installed worker before severing the network and reloading the hosted URL.
  await page.evaluate(()=>navigator.serviceWorker.ready.then(()=>new Promise(resolve=>navigator.serviceWorker.controller?resolve():navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}))));
  await context.setOffline(true);await page.reload();
  await page.locator('#offBadge:not([hidden])').waitFor();
  await page.goto(base+'/?api='+encodeURIComponent(base+'/api')+'&corridor=ab-strathcona-demo#/segment/'+target);
  await page.locator('[data-act="approved"]').first().click();
  await page.getByText('✓ Approved · local demo',{exact:true}).first().waitFor();
  await page.reload();await page.getByText('✓ Approved · local demo',{exact:true}).first().waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS browser: failed approval retry, acknowledged approval, CSV, offline hosted reload, local-only persistence, no page errors');
 } finally {await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
