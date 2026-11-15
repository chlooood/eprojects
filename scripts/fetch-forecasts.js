#!/usr/bin/env node
// Fetch current 16-day weather outside n8n Cloud. Import the generated manual-only seed, then run WF3.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const wiring = require('../workflows/wiring.json');
async function main() {
  const cells = require('../data/cache/cells/trans-northern-cells.json');
  const rows = [];
  for (const c of cells) {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({ latitude:c.cell_lat, longitude:c.cell_lon, daily:'precipitation_sum,temperature_2m_max,temperature_2m_min,soil_moisture_0_to_7cm_mean', forecast_days:'16', timezone:'UTC' });
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('forecast ' + c.cell_key + ': HTTP ' + r.status);
    const raw = await r.text(); const f = JSON.parse(raw);
    if (f.error || !f.daily?.time?.length || !f.daily.precipitation_sum?.every(x => typeof x === 'number' && Number.isFinite(x))) throw new Error('Incomplete forecast for ' + c.cell_key);
    rows.push({ cell_key:c.cell_key, forecast_json:raw, forecast_fetched_at:new Date().toISOString(), forecast_source_url:String(url) });
    console.log(c.cell_key + ': ' + f.daily.time.length + ' days, sha256 ' + crypto.createHash('sha256').update(raw).digest('hex'));
  }
  fs.mkdirSync(path.join(root,'data/cache/forecasts'),{recursive:true});
  fs.writeFileSync(path.join(root,'data/cache/forecasts/latest.json'),JSON.stringify(rows,null,2)+'\n');
  const names = ['Load fresh forecasts','Forecast cache rows','Save forecast cache'];
  const columns = ['forecast_json','forecast_fetched_at','forecast_source_url'];
  const nodes = [
    { id:'forecast-manual', name:names[0], type:'n8n-nodes-base.manualTrigger',typeVersion:1,position:[0,0],parameters:{} },
    { id:'forecast-code', name:names[1], type:'n8n-nodes-base.code',typeVersion:2,position:[220,0],parameters:{jsCode:'// Generated real forecasts. WF3 refuses cached data older than 24 hours.\nconst rows = '+JSON.stringify(rows)+';\nreturn rows.map(json => ({json}));'} },
    { id:'forecast-save', name:names[2], type:'n8n-nodes-base.dataTable',typeVersion:1.1,position:[440,0],parameters:{ operation:'update',dataTableId:{__rl:true,mode:'id',value:wiring.tables.corridor_climate_cells,cachedResultName:'corridor_climate_cells'},matchType:'allConditions',filters:{conditions:[{keyName:'cell_key',keyValue:'={{ $json.cell_key }}'}]},columns:{mappingMode:'defineBelow',value:Object.fromEntries(columns.map(k=>[k,'={{ $json.'+k+' }}'])),schema:columns.map(id=>({id,displayName:id,type:'string',display:true,required:false,canBeUsedToMatch:true}))},options:{} } }
  ];
  const connections=Object.fromEntries(names.slice(0,-1).map((name,i)=>[name,{main:[[{node:names[i+1],type:'main',index:0}]]}]));
  fs.writeFileSync(path.join(root,'workflows/TerraCorridor Seed - Forecast cache.json'),JSON.stringify({name:'TerraCorridor Seed - Forecast cache',nodes,connections,active:false,settings:{executionOrder:'v1'},pinData:{},tags:[]},null,2)+'\n');
}
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
