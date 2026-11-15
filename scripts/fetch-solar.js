#!/usr/bin/env node
// Real NASA POWER inputs and a manual-only seed for corridor_build. No solar/grid values are invented.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.join(__dirname,'..'),wiring=require('../workflows/wiring.json');
async function main(){
 const response=await fetch(wiring.apiBase+'/corridor',{signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw new Error('corridor HTTP '+response.status);
 const feed=await response.json(),cache={};
 for(const s of feed.segments){
  const a=s.centreline[0],b=s.centreline.at(-1),lat=(a[1]+b[1])/2,lon=(a[0]+b[0])/2;
  const latitude=Math.round(lat*2)/2,longitude=Math.round(lon*2)/2,key=latitude.toFixed(1)+','+longitude.toFixed(1);
  if(!cache[key]){
   const url=new URL('https://power.larc.nasa.gov/api/temporal/climatology/point');url.search=new URLSearchParams({parameters:'ALLSKY_SFC_SW_DWN',community:'RE',latitude,longitude,format:'JSON'});
   const r=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error('NASA HTTP '+r.status);
   const raw=await r.text(),data=JSON.parse(raw),irradiance=data.properties?.parameter?.ALLSKY_SFC_SW_DWN?.ANN;
   if(typeof irradiance!=='number'||irradiance<=0||irradiance>12)throw new Error('NASA missing annual irradiance');
   cache[key]={key,url:String(url),fetchedAt:new Date().toISOString(),sha256:crypto.createHash('sha256').update(raw).digest('hex'),irradiance,data};
   console.log(key+': '+irradiance+' kWh/m2/day');
  }
  s.solarCacheKey=key;
 }
 const W5=require('../workflows/TerraCorridor W5 - Solar + Storage Build Layer and Weekly Report.json');
 const js=W5.nodes.find(n=>n.name==='Compute Build Layer').parameters.jsCode;
 const {calcBuild,cfg}=new Function(js.slice(0,js.indexOf('// ================== END SHARED PRELUDE'))+'; return {calcBuild,cfg:DEFAULT_CONFIG};')();
 const config={...cfg,...feed.config.money,buildStripM:feed.config.buildStripM||60,maxBuildSlopePct:feed.config.buildMaxSlopePct||10};
 const rows=feed.segments.map(s=>calcBuild({seg:{segment_id:s.id,corridor_id:feed.meta.corridorId,length_m:s.lengthM},irradiance:cache[s.solarCacheKey].irradiance,irrLabel:'cached_nasa_power',slope:s.slopePct,slopeLabel:'w2_live',risk10_tier:s.risk.y10.tier,riskLabel:'w2_provisional_model',substation_km:s.substationKm,subLabel:s.substationKm==null?'unavailable':'w5_live',geomLabel:'w1_live'},config));
 fs.mkdirSync(path.join(root,'data/cache/solar'),{recursive:true});
 fs.writeFileSync(path.join(root,'data/cache/solar/latest.json'),JSON.stringify({cells:Object.values(cache),segments:feed.segments.map(s=>({id:s.id,key:s.solarCacheKey})),rows},null,2)+'\n');
 const columns=['segment_id','corridor_id','build_score','build_tier','usable_acres','irradiance','slope_pct','substation_km','mw','mwh_per_year','annual_lease_revenue','partner_annual_revenue','operator_annual_revenue','avoided_tco2_per_year','gross_power_value','risk10_tier','data_status','data_labels','calculated_at'];
 const text=['segment_id','corridor_id','build_tier','risk10_tier','data_status','data_labels','calculated_at'];
 const nodes=[{id:'solar-trigger',name:'Load solar inputs',type:'n8n-nodes-base.manualTrigger',typeVersion:1,position:[0,0],parameters:{}},{id:'solar-code',name:'Real solar build rows',type:'n8n-nodes-base.code',typeVersion:2,position:[220,0],parameters:{jsCode:'// NASA POWER climatology + live W2 terrain/risk, calculated with W5 calcBuild. No dispatch or land-rights claim.\nconst rows='+JSON.stringify(rows)+';\nreturn rows.map(json=>({json}));'}},{id:'solar-save',name:'Upsert real build rows',type:'n8n-nodes-base.dataTable',typeVersion:1.1,position:[440,0],parameters:{operation:'upsert',dataTableId:{__rl:true,mode:'id',value:wiring.tables.corridor_build,cachedResultName:'corridor_build'},matchType:'allConditions',filters:{conditions:[{keyName:'segment_id',keyValue:'={{ $json.segment_id }}'}]},columns:{mappingMode:'defineBelow',value:Object.fromEntries(columns.map(k=>[k,'={{ $json.'+k+' }}'])),schema:columns.map(id=>({id,displayName:id,type:text.includes(id)?'string':'number',display:true,required:false,canBeUsedToMatch:true}))},options:{}}}];
 const connections={'Load solar inputs':{main:[[{node:'Real solar build rows',type:'main',index:0}]]},'Real solar build rows':{main:[[{node:'Upsert real build rows',type:'main',index:0}]]}};
 fs.writeFileSync(path.join(root,'workflows/TerraCorridor Seed - Solar inputs.json'),JSON.stringify({name:'TerraCorridor Seed - Solar inputs',nodes,connections,active:false,pinData:{},settings:{executionOrder:'v1'},tags:[]},null,2)+'\n');
}
main().catch(e=>{console.error(e);process.exitCode=1});
