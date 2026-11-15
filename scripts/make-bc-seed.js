#!/usr/bin/env node
// Manual-only, idempotent upserts for the prepared BC corridor; no deletes, emails, or workflow calls.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT=path.join(__dirname,'..'),wiring=require('../workflows/wiring.json');
const tables=require('../data/corridors/bc-coquihalla/tables.json');
const W1=require('../workflows/W1_ Corridor Setup.json'),W2=require('../workflows/W2_ Long-Range Engine.json'),W5=require('../workflows/TerraCorridor W5 - Solar + Storage Build Layer and Weekly Report.json');
const find=(w,name)=>w.nodes.find(n=>n.name===name);
const specs=[['segments','corridor_segments','segment_id',find(W1,'Upsert Segments')],['baselines','corridor_baselines','segment_id',find(W2,'Upsert Baselines')],['predictions','corridor_predictions','prediction_id',find(W2,'Upsert Predictions')],['build','corridor_build','segment_id',find(W5,'Upsert Build Rows')],['buildConfig','corridor_build_config','corridor_id',find(W5,'Save Assumptions')],['sources','corridor_sources','corridor_id',find(W2,'Log Source Hashes')]];
const id=s=>crypto.createHash('sha256').update('bc-seed:'+s).digest('hex').slice(0,24);
const nodes=[{id:id('trigger'),name:'Load Coquihalla assessment',type:'n8n-nodes-base.manualTrigger',typeVersion:1,position:[0,0],parameters:{}}],connections={'Load Coquihalla assessment':{main:[[]]}};
for(const [i,[key,table,match,template]] of specs.entries()){
 if(!template)throw Error('Missing writer template '+table);
 const rows=tables[key];if(!rows.length)throw Error('Missing seed rows '+key);
 if(rows.some(r=>r.corridor_id!=='bc-coquihalla'))throw Error('Refusing non-BC rows');
 const code='BC '+key+' rows',write='Upsert BC '+key;
 nodes.push({id:id(code),name:code,type:'n8n-nodes-base.code',typeVersion:2,position:[240,i*180],parameters:{jsCode:'// Prepared real-data assessment. No external calls.\nconst rows='+JSON.stringify(rows)+';\nreturn rows.map(json=>({json}));'}});
 const n=JSON.parse(JSON.stringify(template));n.id=id(write);n.name=write;n.position=[500,i*180];n.parameters.operation='upsert';n.parameters.dataTableId={__rl:true,mode:'id',value:wiring.tables[table],cachedResultName:table};n.parameters.matchType='allConditions';n.parameters.filters={conditions:[{keyName:match,keyValue:'={{ $json.'+match+' }}'}]};
 if(table==='corridor_sources')n.parameters.filters.conditions.push({keyName:'source_kind',keyValue:'corridor_manifest'});
 if(key==='baselines')n.parameters.columns.schema.push({id:'crossings_json',displayName:'crossings_json',type:'string',display:true,required:false,canBeUsedToMatch:true});
 const values={};for(const col of n.parameters.columns.schema){if(Object.hasOwn(rows[0],col.id))values[col.id]='={{ $json.'+col.id+' }}';}
 if(key==='baselines')values.crossings_json='={{ $json.crossings_json }}';
 n.parameters.columns.value=values;n.parameters.options={};delete n.executeOnce;delete n.alwaysOutputData;delete n.onError;
 if(!Object.keys(values).length)throw Error('No mapped columns '+key);
 nodes.push(n);connections['Load Coquihalla assessment'].main[0].push({node:code,type:'main',index:0});connections[code]={main:[[{node:write,type:'main',index:0}]]};
}
// Climate cells use the existing hazard seed's typed writer; only the BC cell is upserted.
const seed=require('../workflows/TerraCorridor Seed - Hazard inputs.json'),n=JSON.parse(JSON.stringify(find(seed,'Upsert climate cells'))),name='Upsert BC climate cell',code='BC climate cell rows';n.id=id(name);n.name=name;n.position=[500,6*180];
for(const field of ['forecast_json','forecast_fetched_at','forecast_source_url']){if(tables.climateCells[0][field]){n.parameters.columns.value[field]='={{ $json.'+field+' }}';n.parameters.columns.schema.push({id:field,displayName:field,type:'string',display:true,required:false,canBeUsedToMatch:true});}}
nodes.push({id:id(code),name:code,type:'n8n-nodes-base.code',typeVersion:2,position:[240,6*180],parameters:{jsCode:'const rows='+JSON.stringify(tables.climateCells)+';\nreturn rows.map(json=>({json}));'}},n);connections['Load Coquihalla assessment'].main[0].push({node:code,type:'main',index:0});connections[code]={main:[[{node:name,type:'main',index:0}]]};
fs.writeFileSync(path.join(ROOT,'workflows/TerraCorridor Seed - Coquihalla assessment.json'),JSON.stringify({name:'TerraCorridor Seed - Coquihalla assessment',nodes,connections,active:false,pinData:{},settings:{executionOrder:'v1'},tags:[]},null,2)+'\n');
console.log(nodes.length+' nodes; BC rows only; no existing corridor archived or deleted.');
