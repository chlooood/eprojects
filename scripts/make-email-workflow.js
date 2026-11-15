// Generates a disabled SMTP handoff workflow.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const wiring = require('../workflows/wiring.json');
const table = name => ({ __rl:true, mode:'id', value:wiring.tables[name], cachedResultName:name });
const nodes = [];
const add = (name,type,parameters,extra={}) => nodes.push({
  id:'email-'+(nodes.length+1), name,
  type:'n8n-nodes-base.'+type,
  typeVersion:type==='dataTable'?1.1:type==='code'?2:type==='if'?2.2:type==='emailSend'?2.1:type==='scheduleTrigger'?1.2:1,
  position:[nodes.length*220,0], parameters, ...extra
});
const cols = values => ({
  mappingMode:'defineBelow', value:values,
  schema:Object.keys(values).map(id=>({id,displayName:id,type:'string',required:false,display:true,canBeUsedToMatch:true}))
});
const filters = items => ({conditions:items.map(([keyName,keyValue])=>({keyName,keyValue}))});

add('Manual delivery check','manualTrigger',{});
add('Every five minutes','scheduleTrigger',{rule:{interval:[{field:'minutes',minutesInterval:5}]}});
add('Email delivery config','code',{
  jsCode:"return [{ json: { enabled:false, from:'', to:'', maxPerRun:3 } }];"
});
add('Delivery enabled?','if',{
  conditions:{
    options:{typeValidation:'strict',version:2},
    conditions:[{
      leftValue:'={{ $json.enabled === true && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test($json.from) && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test($json.to) }}',
      rightValue:true,
      operator:{type:'boolean',operation:'true',singleValue:true}
    }],
    combinator:'and'
  },options:{}
});
add('Get queued approved orders','dataTable',{
  operation:'get',dataTableId:table('corridor_work_orders'),
  matchType:'allConditions',
  filters:filters([['status','approved'],['delivery_state','queued']]),
  limit:'={{ $("Email delivery config").first().json.maxPerRun }}'
});
add('Prepare inspection email','code',{jsCode:`
const cfg = $('Email delivery config').first().json;
return $input.all().flatMap((item,i)=>{
  const w=item.json;
  if(w.status!=='approved'||w.delivery_state!=='queued'||!w.work_order_id)return [];
  let facts=[];try{facts=JSON.parse(w.facts_json||'[]');}catch(_){}
  return [{json:{
    ...w,email_from:cfg.from,email_to:cfg.to,
    email_subject:'[TerraCorridor] Approved inspection '+w.work_order_id,
    email_body:[
      'Approved inspection handoff',
      'Work order: '+w.work_order_id,
      'Segment: '+w.segment_id,
      'Priority: '+w.priority,
      'Approved by: '+(w.decided_by||'integrity manager'),
      'Approved at: '+(w.decided_at||''),
      '',w.summary||'','',
      ...(Array.isArray(facts)?facts.filter(x=>typeof x==='string'&&!x.startsWith('Next step:')):[]),
      '',
      'Coordinator: review this order, import it into your maintenance system, and schedule the inspection.',
      'This email is a handoff. No crew has been dispatched and no SAP/Maximo ticket has been created.'
    ].join('\\n')
  },pairedItem:{item:i}}];
});`
});
add('Claim queued order','dataTable',{
  operation:'update',dataTableId:table('corridor_work_orders'),
  matchType:'allConditions',
  filters:filters([
    ['work_order_id','={{ $json.work_order_id }}'],
    ['status','approved'],
    ['delivery_state','queued']
  ]),
  columns:cols({
    delivery_state:'sending',
    delivery_attempted_at:'={{ $now.toISO() }}',
    delivery_recipient:'={{ $json.email_to }}'
  }),options:{}
});
add('Send inspection email','emailSend',{
  fromEmail:'={{ $("Prepare inspection email").item.json.email_from }}',
  toEmail:'={{ $("Prepare inspection email").item.json.email_to }}',
  subject:'={{ $("Prepare inspection email").item.json.email_subject }}',
  emailFormat:'text',
  text:'={{ $("Prepare inspection email").item.json.email_body }}',
  options:{appendAttribution:false}
},{onError:'continueErrorOutput',retryOnFail:false});

const update=(name,state)=>add(name,'dataTable',{
  operation:'update',dataTableId:table('corridor_work_orders'),
  matchType:'allConditions',
  filters:filters([['work_order_id','={{ $("Prepare inspection email").item.json.work_order_id }}']]),
  columns:cols({
    delivery_state:state,
    ...(state==='provider_accepted'
      ?{delivery_accepted_at:'={{ $now.toISO() }}',delivery_error:''}
      :{delivery_error:'SMTP failed or response uncertain. Check the execution and provider before manually requeuing.'})
  }),options:{}
});
update('Record provider acceptance','provider_accepted');
update('Record uncertain delivery','needs_review');

const audit=(name,ok)=>add(name,'dataTable',{
  dataTableId:table('corridor_audit'),
  columns:{
    mappingMode:'defineBelow',
    value:{
      logged_at:'={{ $now.toISO() }}',
      action:ok?'inspection_email_accepted':'inspection_email_needs_review',
      actor:'n8n:email-delivery',
      segment_id:'={{ $("Prepare inspection email").item.json.segment_id }}',
      work_order_id:'={{ $("Prepare inspection email").item.json.work_order_id }}',
      source:'smtp',ok,
      details_json:'={{ JSON.stringify({recipient:$("Email delivery config").first().json.to,dispatched:false}) }}'
    },
    schema:['logged_at','action','actor','segment_id','work_order_id','source','ok','details_json'].map(id=>({
      id,displayName:id,
      type:id==='ok'?'boolean':id==='logged_at'?'dateTime':'string',
      display:true,required:false,canBeUsedToMatch:true
    }))
  },options:{}
});
audit('Log email acceptance',true);
audit('Log delivery review needed',false);

const connections={};
const link=(from,to,branch=0)=>{
  const main=(connections[from]||={main:[]}).main;
  while(main.length<=branch)main.push([]);
  main[branch].push({node:to,type:'main',index:0});
};
for(const trigger of ['Manual delivery check','Every five minutes'])link(trigger,'Email delivery config');
for(const [a,b] of [
  ['Email delivery config','Delivery enabled?'],
  ['Delivery enabled?','Get queued approved orders'],
  ['Get queued approved orders','Prepare inspection email'],
  ['Prepare inspection email','Claim queued order'],
  ['Claim queued order','Send inspection email'],
  ['Send inspection email','Record provider acceptance'],
  ['Record provider acceptance','Log email acceptance'],
  ['Record uncertain delivery','Log delivery review needed']
])link(a,b);
link('Send inspection email','Record uncertain delivery',1);

fs.writeFileSync(
  path.join(root,'workflows','TerraCorridor Email - Approved inspection handoff.json'),
  JSON.stringify({
    name:'TerraCorridor Email - Approved inspection handoff',
    nodes,connections,active:false,pinData:{},
    settings:{executionOrder:'v1'},tags:[]
  },null,2)+'\n'
);
console.log('Email workflow generated; sending is disabled until configured.');