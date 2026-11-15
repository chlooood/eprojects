const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs');
const {buildCorridor}=require('../src/dashboard-api'),{statsProfile}=require('../scripts/prepare-bc-corridor');
const bc=require('../data/corridors/bc-coquihalla/assessment.json'),ab=require('../data/snapshot/live-snapshot.json'),tables=require('../data/corridors/bc-coquihalla/tables.json');
test('BC uses unchanged thresholds, audited real inputs and 12 globally distinct IDs',()=>{
 assert.equal(bc.meta.synthetic,false);assert.equal(bc.segments.length,12);
 assert.equal(bc.config.ratioFull,ab.config.ratioFull);assert.deepEqual(bc.config.tiers,ab.config.tiers);
 const ids=new Set(ab.segments.map(s=>s.id));assert.ok(bc.segments.every(s=>!ids.has(s.id)&&s.id.startsWith('bc_coq_')));
 assert.deepEqual(Object.keys(bc.segments[0].risk.y10.hazards).sort(),['crossing','drought','ground','wildfire']);
 assert.equal(bc.segments.filter(s=>s.risk.y10.tier==='red').length,4);
 assert.ok(bc.segments.filter(s=>s.risk.y10.tier==='red').every(s=>s.risk.y10.hazard==='crossing'));
 assert.ok(bc.segments.every(s=>s.terrain.samples.length===11));
});
test('terrain profile exposes a hidden valley without replacing the endpoint scoring factor',()=>{
 const p=statsProfile([100,50,100],1000);assert.equal(p.netGradePct,0);assert.equal(p.reliefM,50);assert.equal(p.maxSampleGradePct,10);
 assert.throws(()=>statsProfile([100,null,100],1000),/Invalid/);
});
test('API selects a corridor explicitly and prevents foreign orders, audit and metadata leaking across corridors',()=>{
 const b=tables.segments[0];const foreign={...b,segment_id:'ab_test',corridor_id:'ab-strathcona-demo'};
 const mixed={...tables,segments:[foreign,...tables.segments],workOrders:[{segment_id:'ab_test',work_order_id:'AB_ONLY',status:'approved'}],audit:[{segment_id:'ab_test',action:'approve'}]};
 const result=buildCorridor(mixed,{corridorId:'bc-coquihalla'});
 assert.equal(result.meta.corridorId,'bc-coquihalla');assert.equal(result.segments.length,12);
 assert.equal(result.meta.name,'Coquihalla mountain corridor');assert.ok(!result.meta.note.includes('near Edmonton'));
 assert.equal(result.audit.length,0);assert.ok(result.segments.every(s=>!s.workOrder));
 const empty=buildCorridor(mixed,{corridorId:'missing'});assert.equal(empty.segments.length,0);
});
test('manual BC seed has no deletion, schedule, notification or workflow execution paths',()=>{
 const seed=require('../workflows/TerraCorridor Seed - Coquihalla assessment.json');assert.equal(seed.active,false);
 assert.equal(seed.nodes.length,15);assert.equal(seed.nodes.filter(n=>n.type.endsWith('.manualTrigger')).length,1);
 for(const n of seed.nodes){
  assert.ok(['n8n-nodes-base.manualTrigger','n8n-nodes-base.code','n8n-nodes-base.dataTable'].includes(n.type));
  if(n.type.endsWith('.dataTable')){assert.equal(n.parameters.operation,'upsert');assert.ok(n.parameters.filters.conditions.length);}
  if(n.type.endsWith('.code')){const rows=new Function(n.parameters.jsCode)().map(i=>i.json);assert.ok(rows.every(r=>r.corridor_id==='bc-coquihalla'||r.cell_key==='49.40_-121.30'));}
 }
});
test('BC source imagery is independent and has sufficient real observations for every segment',()=>{
 const n=require('../data/corridors/bc-coquihalla/ndvi.json');assert.equal(n.sources.length,12);
 assert.ok(n.sources.every(s=>!s.month.startsWith('2022')));
 for(const source of n.sources){const record=require('../data/corridors/bc-coquihalla/raw/ndvi-'+source.month+'.json');assert.equal(record.scene.collection,'sentinel-2-c1-l2a');assert.ok(record.scene.assets.red['raster:bands'][0].scale>0);}
 for(const seg of bc.segments){const rows=n.observations.filter(o=>o.segment_id===seg.id&&o.mean!=null);const count={};for(const o of rows)count[o.month.slice(0,4)]=(count[o.month.slice(0,4)]||0)+1;assert.equal(Object.values(count).filter(v=>v>=2).length,4);}
});

test('actual seed column mappings round-trip into a complete BC API response',()=>{
 const seed=require('../workflows/TerraCorridor Seed - Coquihalla assessment.json');const reconstructed={};
 const names={segments:'corridor_segments',baselines:'corridor_baselines',predictions:'corridor_predictions',build:'corridor_build',buildConfig:'corridor_build_config',sources:'corridor_sources'};
 for(const [key,table]of Object.entries(names)){
  const writer=seed.nodes.find(n=>n.type.endsWith('.dataTable')&&n.parameters.dataTableId.cachedResultName===table);
  const inputNode=seed.nodes.find(n=>seed.connections[n.name]?.main?.[0]?.some(e=>e.node===writer.name));
  const rows=new Function(inputNode.parameters.jsCode)().map(i=>i.json);
  reconstructed[key]=rows.map(row=>Object.fromEntries(Object.entries(writer.parameters.columns.value).map(([key,expr])=>{
   const field=expr.match(/\$json\.([a-zA-Z0-9_]+)/)?.[1];assert.ok(field);return [key,row[field]];
  })));
 }
 const d=buildCorridor(reconstructed,{corridorId:'bc-coquihalla'});
 assert.equal(d.meta.segmentsVerified,12);assert.equal(d.meta.name,'Coquihalla mountain corridor');
 assert.equal(d.segments.filter(s=>s.risk.y10.tier==='red').length,4);
 assert.ok(d.segments.every(s=>s.irradiance>0&&s.ndvi.source==='earthsearch_c1_sentinel2_cached'&&s.terrain.samples.length===11));
 assert.ok(reconstructed.baselines.every(b=>Array.isArray(JSON.parse(b.crossings_json))));
});
