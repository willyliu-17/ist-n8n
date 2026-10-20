// Reproducibly assemble native workflows from pure contracts; no network operations.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./streamer-history-core');
const schema = require('./streamer-history-schema');
const root = path.resolve(__dirname, '..');
const core = fs.readFileSync(path.join(__dirname, 'streamer-history-core.js'), 'utf8');
const inventory = [
  ['History: write row v1', 'streamer_history_write_v1_HistoryWriteV1A1', 'HistoryWriteV1A1'],
  ['History: import request v1', 'streamer_history_import_request_v1_HistoryRequestV1', 'HistoryRequestV1'],
  ['History: ingest v1', 'streamer_thermal_history_ingest_v1_HistoryIngestV1A', 'HistoryIngestV1A'],
  ['History: lookup v1', 'streamer_thermal_history_lookup_v1_HistoryLookupV1A', 'HistoryLookupV1A'],
  ['History: notify completed v1', 'streamer_thermal_history_notify_v1_HistoryNotifyV1A', 'HistoryNotifyV1A'],
  ['History: deliver one v1', 'streamer_history_deliver_v1_HistoryDeliverV1', 'HistoryDeliverV1'],
  ['History: reply to command v1', 'streamer_history_reply_v1_HistoryReplyV1A', 'HistoryReplyV1A'],
  ['History: register daily v1', 'streamer_history_register_v1_HistoryRegister1', 'HistoryRegister1'],
];
const uuid = value => { const x = crypto.createHash('sha256').update(value).digest('hex'); return `${x.slice(0,8)}-${x.slice(8,12)}-4${x.slice(13,16)}-8${x.slice(17,20)}-${x.slice(20,32)}`; };
class Workflow {
  constructor(tuple) { [this.name, this.dir, this.id] = tuple; this.nodes = []; this.connections = {}; this.files = {}; }
  node(name, type, version, parameters, extra = {}) {
    this.nodes.push({ id: uuid(this.id + name), name, type: `n8n-nodes-base.${type}`, typeVersion: version, position: [(this.nodes.length % 6) * 260, Math.floor(this.nodes.length / 6) * 240], parameters, ...(type === 'slack' ? { webhookId: uuid(this.id + name + ':webhook') } : {}), ...extra });
    return name;
  }
  code(name, body) {
    const file = `nodes/${name.replace(/\W+/g, '_')}/jsCode.js`;
    this.files[file] = `${body.includes('History.') ? core + '\n' : ''}${body}\n`;
    return this.node(name, 'code', 2, { mode: 'runOnceForAllItems', jsCode: `__EXTERNAL_FILE__://${file}` });
  }
  connect(a, b, output = 0, input = 0) {
    const c = this.connections[a] ||= { main: [] };
    while (c.main.length <= output) c.main.push([]);
    c.main[output].push({ node: b, type: 'main', index: input });
  }
  start(body) {
    this.node('Start', 'executeWorkflowTrigger', 1.1, { workflowInputs: { values: [{ name: 'payload', type: 'object' }] } });
    this.code('Input', `if ($input.all().length !== 1) throw new Error('history_expected_single_input');\nconst raw=$input.first().json;const payload=raw.payload||raw;\n${body.replaceAll('$input.first().json', 'payload')}`);
    this.connect('Start', 'Input');
  }
  read(name, table, conditions = [], source, limit) {
    this.node(name, 'dataTable', 1.1, { resource: 'row', operation: 'get', dataTableId: { __rl: true, mode: 'name', value: table }, matchType: 'allConditions', filters: { conditions }, returnAll: !limit, ...(limit ? { limit } : {}) }, { alwaysOutputData: true });
    if (source) this.connect(source, name);
    return name;
  }
  route(name, field, values) {
    return this.node(name, 'switch', 3.4, { rules: { values: values.map(value => ({ conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 3 }, conditions: [{ id: uuid(name + value), leftValue: field, rightValue: value, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } })) }, options: { fallbackOutput: 'extra' } });
  }
  call(name, id, source) {
    this.node(name, 'executeWorkflow', 1.3, { workflowId: { __rl: true, mode: 'id', value: id, cachedResultName: inventory.find(item => item[2] === id)[0] }, workflowInputs: { mappingMode: 'defineBelow', value: { payload: '={{ $json }}' }, schema: [{ id: 'payload', displayName: 'payload', type: 'object', required: true, display: true }], matchingColumns: [], attemptToConvertTypes: false, convertFieldsToString: false }, mode: 'once', options: { waitForSubWorkflow: true } });
    if (source) this.connect(source, name);
  }
  save() {
    const base = path.join(root, 'workflows', this.dir);
    for (const [file, source] of Object.entries(this.files)) { fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true }); fs.writeFileSync(path.join(base, file), source); }
    const active = this.id !== 'HistoryNotifyV1A';
    const workflow = { id: this.id, name: this.name, active, nodes: this.nodes, connections: this.connections, tags: [{ name: 'ist-bot-v3' }], settings: { executionOrder: 'v1', timezone: 'Asia/Taipei', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true, saveExecutionProgress: false, errorWorkflow: 'AutomationErrorV3A1' } };
    fs.writeFileSync(path.join(base, 'workflow.json'), JSON.stringify(workflow, null, 2) + '\n');
  }
}
const eq = (keyName, keyValue) => ({ keyName, condition: 'eq', keyValue });

function writer() {
  const w = new Workflow(inventory[0]);
  w.start(`const op = $input.first().json; History.planWrite({...op,expected:undefined}, [], new Date().toISOString()); return [{json:op}];`);
  const tables = Object.values(H.TABLES).filter(t => t !== H.TABLES.reviews);
  function reads(routeName, target) {
    w.route(routeName, "={{ $('Input').first().json.table }}", tables);
    for (const [i, table] of tables.entries()) {
      const read = `${routeName} ${i}`;
      w.read(read, table, [eq("={{ $('Input').first().json.keyField }}", "={{ $('Input').first().json.key }}")]);
      w.connect(routeName, read, i); w.connect(read, target);
    }
    w.connect(routeName, 'Invalid Route', tables.length);
  }
  w.node('Invalid Route', 'stopAndError', 1, {errorMessage:'history_invalid_route'});
  reads('Read Existing', 'Plan'); w.connect('Input', 'Read Existing');
  w.code('Plan', `return [{json: History.planWrite($('Input').first().json, $input.all().map(i=>i.json), new Date().toISOString())}];`);
  w.route('Action', '={{ $json.action }}', ['insert', 'update', 'noop']); w.connect('Plan', 'Action');
  w.code('No Change', `return [{json: $input.first().json.row}];`); w.connect('Action', 'No Change', 2); w.connect('Action', 'Invalid Route', 3);
  for (const [out, action] of ['insert', 'update'].entries()) {
    const route = `Route ${action}`;
    w.route(route, "={{ $('Input').first().json.table }}", tables); w.connect('Action', route, out);
    w.connect(route, 'Invalid Route', tables.length);
    w.node(`Limit ${action}`, 'limit', 1, { maxItems: 1 });
    for (const [i, table] of tables.entries()) {
      const value = Object.fromEntries(schema[table].map(c => [c.name, `={{ $json.values.${c.name} ?? '' }}`]));
      const conditions = ['id', ...schema[table].map(c=>c.name)].map(keyName=>({keyName,condition:`={{ $json.snapshot.${keyName} == null ? 'isEmpty' : 'eq' }}`,keyValue:`={{ $json.snapshot.${keyName} ?? '' }}`}));
      const name = `${action} ${i}`;
      w.node(name, 'dataTable', 1.1, { resource: 'row', operation: action, dataTableId: { __rl: true, mode: 'name', value: table }, ...(action === 'update' ? { matchType: 'allConditions', filters: { conditions } } : {}), columns: { mappingMode: 'defineBelow', value, schema: schema[table].map(c => ({ id: c.name, displayName: c.name, type: c.type, required: false, display: true, canBeUsedToMatch: true })) }, options: {} }, { alwaysOutputData: true });
      w.connect(route, name, i); w.connect(name, `Limit ${action}`);
    }
  }
  w.connect('Limit insert', 'Read Existing');
  w.code('Require Updated Row', `if(!$input.first().json.id)throw new Error('history_zero_row_cas');return $input.all();`);
  reads('Read Verified', 'Verify'); w.connect('Limit update', 'Require Updated Row');w.connect('Require Updated Row','Read Verified');
  w.code('Verify', `return [{json:History.verifyWrite($('Input').first().json,$input.all().map(i=>i.json))}];`);
  w.save();
}
function importer() {
  const w = new Workflow(inventory[1]);
  w.start(`const r=$input.first().json; if(!History.filterSource(r)) throw new Error('history_invalid_source'); return [{json:{...r,needsJobs:History.needsJobContext(r)}}];`);
  w.route('Context Source', "={{ $json.needsJobs ? 'jobs' : 'inline' }}", ['jobs','inline']);w.connect('Input','Context Source');
  w.read('Read Matching Jobs', 'stt_jobs_v3', [eq('requestKey', "={{ $('Input').first().json.requestKey }}")]);w.connect('Context Source','Read Matching Jobs');w.connect('Context Source','Build Records',1);
  w.node('Invalid Context Route','stopAndError',1,{errorMessage:'history_invalid_context_route'});w.connect('Context Source','Invalid Context Route',2);
  w.code('Build Records', `const r=$('Input').first().json;return History.records(r, r.needsJobs?$input.all().map(i=>i.json):[]).map(json=>({json}));`); w.connect('Read Matching Jobs', 'Build Records');
  w.node('Write Loop', 'splitInBatches', 3, { batchSize: 1, options: {} }); w.connect('Build Records', 'Write Loop');
  w.call('Write Record', inventory[0][2]); w.connect('Write Loop', 'Write Record', 1); w.connect('Write Record', 'Write Loop');
  w.node('Limit Done', 'limit', 1, { maxItems: 1 }); w.connect('Write Loop', 'Limit Done', 0);
  w.code('Return Result', `return [{json:{sourceRequestKey:$('Input').first().json.requestKey,status:'indexed'}}];`); w.connect('Limit Done', 'Return Result');
  w.save();
}
function ingest() {
  const w = new Workflow(inventory[2]);
  w.start(`return [{json:{startedAtIso:new Date().toISOString(),mode:$input.first().json.mode||'incremental'}}];`);
  w.node('Every Five Minutes', 'scheduleTrigger', 1.4, { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } }); w.connect('Every Five Minutes', 'Input');
  w.read('Read Watermark', H.TABLES.state, [eq('stateKey', 'watermark:production:summary')], 'Input');
  w.code('Read Window', `const rows=$input.all().map(i=>i.json).filter(r=>r.id);if(rows.length>1||rows.some(r=>!History.selfLinked(r)))throw new Error('history_watermark_conflict');const old=rows[0]?.watermarkUpdatedAtIso;const mode=$('Input').first().json.mode;if(!['incremental','historical_backfill'].includes(mode))throw new Error('history_invalid_mode');return [{json:{updatedSince:mode==='historical_backfill'||!old?History.CUTOFF:new Date(Date.parse(old)-300000).toISOString()}}];`); w.connect('Read Watermark', 'Read Window');
  w.read('Read Sources', 'summary_requests_v3', [eq('channel', H.CHANNEL), { keyName: 'createdAtIso', condition: 'gte', keyValue: H.CUTOFF }, { keyName: 'updatedAtIso', condition: 'gte', keyValue: '={{ $json.updatedSince }}' }, eq('reconciliationStatus', 'canonical')], 'Read Window');
  w.code('Prepare Sources', `const rows=$input.all().map(i=>i.json).filter(r=>r.id);for(const r of rows)if(!History.filterSource(r))throw new Error('history_source_not_canonical');return [...rows.map(json=>({json})),{json:{_watermark:true}}];`); w.connect('Read Sources', 'Prepare Sources');
  w.node('Source Loop', 'splitInBatches', 3, { batchSize: 1, options: {} }); w.connect('Prepare Sources', 'Source Loop');
  w.code('Source Kind', `return $input.all().map(i=>({json:{...i.json,_kind:i.json._watermark?'watermark':'source'}}));`); w.connect('Source Loop', 'Source Kind', 1);
  w.route('Route Source', '={{ $json._kind }}', ['source', 'watermark']); w.connect('Source Kind', 'Route Source');
  w.call('Import Request', inventory[1][2]); w.connect('Route Source', 'Import Request'); w.connect('Import Request', 'Source Loop');
  w.code('Watermark Operation', `return [{json:History.operation(History.TABLES.state,'stateKey',{stateKey:'watermark:production:summary',recordType:'watermark',watermarkUpdatedAtIso:$('Input').first().json.startedAtIso},['watermarkUpdatedAtIso'])}];`); w.connect('Route Source', 'Watermark Operation', 1);
  w.call('Save Watermark', inventory[0][2], 'Watermark Operation'); w.connect('Save Watermark', 'Source Loop');
  w.node('Limit Done', 'limit', 1, { maxItems: 1 }); w.connect('Source Loop', 'Limit Done');
  w.code('Return Result', `return [{json:{status:'indexed',asOf:$('Input').first().json.startedAtIso}}];`); w.connect('Limit Done', 'Return Result');
  w.save();
}
function lookup() {
  const w = new Workflow(inventory[3]);
  w.start(`const input=$input.first().json; if(typeof input.userID!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.userID))throw new Error('history_invalid_user_id');return [{json:input}];`);
  let previous = 'Input';
  for (const [kind, table] of Object.entries(H.TABLES)) {
    const read = `Read ${kind}`;
    w.read(read, table, [eq('userID', "={{ $('Input').first().json.userID }}")], previous);
    w.code(`Collect ${kind}`, `return [{json:{rows:$input.all().map(i=>i.json).filter(r=>r.id)}}];`); w.connect(read, `Collect ${kind}`); previous = `Collect ${kind}`;
  }
  w.read('Read Watermark',H.TABLES.state,[eq('stateKey','watermark:production:summary')],previous);
  w.code('Build History', `const data={${Object.keys(H.TABLES).map(k => `${k}:$('Collect ${k}').first().json.rows`).join(',')}};data.state.push(...$input.all().map(i=>i.json).filter(r=>r.id));return [{json:History.lookup($('Input').first().json,data)}];`); w.connect('Read Watermark', 'Build History');
  w.save();
}
const slackCredentials = () => JSON.parse(fs.readFileSync(path.join(root, 'workflows/ist_bot_entry_v3_IstBotEntryV3A01/workflow.json'))).nodes.find(n=>n.type==='n8n-nodes-base.slack').credentials;
function notify() {
  const w=new Workflow(inventory[4]);
  w.start(`return [{json:{}}];`);
  w.node('Every Five Minutes','scheduleTrigger',1.4,{rule:{interval:[{field:'minutes',minutesInterval:5}]}});w.connect('Every Five Minutes','Input');
  w.read('Pending Deliveries',H.TABLES.state,[eq('recordType','notification'),eq('deliveryStatus','pending'),eq('triggerKind','daily'),eq('reconciliationStatus','canonical')],'Input');
  w.code('Eligible Deliveries',`return $input.all().filter(i=>History.selfLinked(i.json)&&i.json.channel===History.CHANNEL);`);w.connect('Pending Deliveries','Eligible Deliveries');
  w.node('Delivery Loop','splitInBatches',3,{batchSize:1,options:{}});w.connect('Eligible Deliveries','Delivery Loop');
  w.call('Deliver One',inventory[5][2]);w.nodes.find(n=>n.name==='Deliver One').alwaysOutputData=true;w.connect('Delivery Loop','Deliver One',1);w.connect('Deliver One','Delivery Loop');
  w.node('Limit Done','limit',1,{maxItems:1});w.connect('Delivery Loop','Limit Done');w.save();
}
function deliver() {
  const w=new Workflow(inventory[5]);
  w.start(`const row=payload;if(!History.selfLinked(row)||row.recordType!=='notification'||row.triggerKind!=='daily'||row.channel!==History.CHANNEL||row.deliveryStatus!=='pending')throw new Error('history_invalid_delivery');return [{json:row}];`);
  w.read('Read Summary','summary_requests_v3',[eq('requestKey',"={{ $('Input').first().json.sourceRequestKey }}")],'Input');
  w.code('Ready Summary',`const rows=$input.all().map(i=>i.json).filter(r=>r.id);if(!rows.length)return [];if(rows.length!==1||!History.selfLinked(rows[0]))throw new Error('history_summary_conflict');const r=rows[0],n=$('Input').first().json;if(r.status!=='completed'||!r.summaryMessageTS||!r.summaryUploadID)return [];if(!History.filterSource(r)||r.channel!==n.channel||r.threadTS!==n.threadTS||History.identity(r).userID!==n.userID)throw new Error('history_delivery_identity_conflict');return [{json:{userID:n.userID,presentationMode:'daily_completed',beforeIso:r.createdAtIso,excludeRequestKey:r.requestKey}}];`);w.connect('Read Summary','Ready Summary');
  w.call('Lookup History',inventory[3][2],'Ready Summary');
  w.code('Claim Operation',`if($input.first().json.historyStatus!=='ok')return [];const row=$('Input').first().json;const fields=${JSON.stringify(schema[H.TABLES.state].map(c=>c.name).filter(k=>!['reconciliationStatus','canonicalRowID','updatedAtIso'].includes(k)))};const values=Object.fromEntries(fields.map(k=>[k,row[k]??'']));values.deliveryStatus='sending';values.deliveryToken=String($execution.id);const op=History.operation(History.TABLES.state,'stateKey',values,['deliveryStatus','deliveryToken']);op.expected={deliveryStatus:'pending',updatedAtIso:row.updatedAtIso};return [{json:op}];`);w.connect('Lookup History','Claim Operation');
  w.call('Claim Delivery',inventory[0][2],'Claim Operation');
  w.node('Send History','slack',2.3,{select:'channel',channelId:{__rl:true,mode:'id',value:"={{ $('Input').first().json.channel }}"},text:"={{ $('Lookup History').first().json.pages.join('\\n\\n') }}",otherOptions:{thread_ts:{replyValues:{thread_ts:"={{ $('Input').first().json.threadTS }}"}}}},{credentials:slackCredentials(),onError:'continueErrorOutput'});w.connect('Claim Delivery','Send History');
  w.node('Delivery Unknown','stopAndError',1,{errorMessage:'history_delivery_unknown_do_not_resend'});w.connect('Send History','Delivery Unknown',1);
  w.code('Sent Operation',`const s=$input.first().json;const ts=s.message_timestamp||s.ts;if(!/^\\d{10,}\\.\\d{6}$/.test(ts||''))throw new Error('history_delivery_unknown_do_not_resend');const op=$('Claim Operation').first().json;return [{json:{...op,values:{...op.values,deliveryStatus:'sent',deliveryMessageTS:ts},mutable:['deliveryStatus','deliveryMessageTS'],expected:{deliveryStatus:'sending',deliveryToken:op.values.deliveryToken}}}];`);w.connect('Send History','Sent Operation');
  w.call('Checkpoint Delivery',inventory[0][2],'Sent Operation');w.save();
}
function reply() {
  const w=new Workflow(inventory[6]);
  w.start(`const c=payload;if(!['C09F0SYG57D','C0A4JJJKJMD'].includes(c.channel)||c.positionals?.length!==1||Object.keys(c.args||{}).length||!/^\\d{10,}\\.\\d{6}$/.test(c.thread_ts||''))throw new Error('history_invalid_command');return [{json:{userID:c.positionals[0],channel:c.channel,threadTS:c.thread_ts}}];`);
  w.call('Lookup History',inventory[3][2],'Input');
  w.nodes.find(n=>n.name==='Lookup History').onError='continueErrorOutput';
  w.code('Pages',`const result=$input.first().json;return result.pages.map((text,i)=>({json:{text:text+'\\n頁 '+(i+1)+' / '+result.pages.length,channel:$('Input').first().json.channel,threadTS:$('Input').first().json.threadTS}}));`);w.connect('Lookup History','Pages');
  w.node('Reply','slack',2.3,{select:'channel',channelId:{__rl:true,mode:'id',value:'={{ $json.channel }}'},text:'={{ $json.text }}',otherOptions:{thread_ts:{replyValues:{thread_ts:'={{ $json.threadTS }}'}}}},{credentials:slackCredentials()});w.connect('Pages','Reply');
  w.node('Reply Query Failure','slack',2.3,{select:'channel',channelId:{__rl:true,mode:'id',value:"={{ $('Input').first().json.channel }}"},text:'暫時無法讀取主播歷史，請稍後再試。',otherOptions:{thread_ts:{replyValues:{thread_ts:"={{ $('Input').first().json.threadTS }}"}}}},{credentials:slackCredentials()});w.connect('Lookup History','Reply Query Failure',1);w.save();
}
function register() {
  const w=new Workflow(inventory[7]);
  w.start(`const input=payload;const r=input.request;if(input.triggerKind!=='daily'||r?.channel!==History.CHANNEL)return [];const current=r.orderedStreams?.find(s=>s.role==='current');if(!current?.streamContext?.userID)throw new Error('history_missing_user_id');const userID=current.streamContext.userID;const op=History.operation(History.TABLES.state,'stateKey',{stateKey:History.key('notification',[r.requestKey]),recordType:'notification',userID,sourceRequestKey:r.requestKey,channel:r.channel,threadTS:r.threadTS,triggerKind:'daily',deliveryStatus:'pending',deliveryToken:'',deliveryMessageTS:''});op.createOnly=true;return [{json:op}];`);
  w.call('Register Delivery',inventory[0][2],'Input');w.save();
}
function integrate() {
  const provisionDir=path.join(root,'workflows/automation_provision_state_v3_AutomationProvV3A1');
  const schemaPath=path.join(provisionDir,'nodes/State_Schema/schema.json');
  const allSchema={...JSON.parse(fs.readFileSync(schemaPath)),...schema};
  const schemaJson=JSON.stringify(allSchema,null,2).replace(/\{\n\s+"name": "([^"]+)",\n\s+"type": "([^"]+)"\n\s+\}/g,'{ "name": "$1", "type": "$2" }');
  fs.writeFileSync(schemaPath,schemaJson+'\n');
  const manifestTables=Object.entries(allSchema).map(([name,columns])=>{
    const lines=[];for(let index=0;index<columns.length;index+=2)lines.push('    '+columns.slice(index,index+2).map(c=>`{ name: '${c.name}', type: '${c.type}' },`).join(' '));
    return `  ${name}: [\n${lines.join('\n')}\n  ],`;
  });
  fs.writeFileSync(path.join(provisionDir,'nodes/Build_Provisioning_Manifest/jsCode.js'),`const schema = {\n${manifestTables.join('\n')}\n};\n\nreturn Object.entries(schema).map(([tableName, columns]) => ({\n  json: { tableName, columnsJson: JSON.stringify(columns), columnCount: columns.length },\n}));\n`);
  const p=JSON.parse(fs.readFileSync(path.join(provisionDir,'workflow.json')));
  const route=p.nodes.find(n=>n.name==='Route Expected Table');
  for(const [offset,table] of Object.keys(schema).entries()){
    const name=`Probe History ${offset}`;
    if(p.nodes.some(n=>n.name===name))continue;
    const rule=structuredClone(route.parameters.rules.values[0]);rule.conditions.conditions[0].id=uuid(name);rule.conditions.conditions[0].rightValue=table;route.parameters.rules.values.push(rule);
    const probe=structuredClone(p.nodes.find(n=>n.name==='Probe Suspect Candidates'));probe.name=name;probe.id=uuid(name);probe.parameters.dataTableId.value=table;probe.position=[720,500+offset*200];p.nodes.push(probe);
    p.connections['Route Expected Table'].main.push([{node:name,type:'main',index:0}]);p.connections[name]={main:[[{node:'Wait for Table Probes',type:'main',index:4+offset}]]};
  }
  p.nodes.find(n=>n.name==='Wait for Table Probes').parameters.numberInputs=Object.keys(allSchema).length;
  fs.writeFileSync(path.join(provisionDir,'workflow.json'),JSON.stringify(p,null,2)+'\n');
  const botPath=path.join(root,'workflows/ist_bot_entry_v3_IstBotEntryV3A01/workflow.json');const bot=JSON.parse(fs.readFileSync(botPath));
  if(!bot.nodes.some(n=>n.name==='Call Streamer History')){
    const rule=structuredClone(bot.nodes.find(n=>n.name==='Command Switch').parameters.rules.values[0]);rule.conditions.conditions[0].id=uuid('history-command');rule.conditions.conditions[0].rightValue='v3:history:streamer';bot.nodes.find(n=>n.name==='Command Switch').parameters.rules.values.push(rule);
    const b=new Workflow(['integration','unused','integration']);b.call('Call Streamer History',inventory[6][2]);b.nodes[0].parameters.mode='each';b.nodes[0].parameters.options.waitForSubWorkflow=false;bot.nodes.push(b.nodes[0]);bot.connections['Command Switch'].main.push([{node:'Call Streamer History',type:'main',index:0}]);
  }
  bot.nodes.find(n=>n.name==='Call Streamer History').parameters.workflowId.cachedResultName=inventory[6][0];
  fs.writeFileSync(botPath,JSON.stringify(bot,null,2)+'\n');
  const collectorPath=path.join(root,'workflows/collect_suspect_streamid_v3_CollectSuspectV3/workflow.json');const c=JSON.parse(fs.readFileSync(collectorPath));
  for(const [name,value] of [['Configure Scheduled Run','daily'],['Configure Manual Run','manual']]){
    const list=c.nodes.find(n=>n.name===name).parameters.assignments.assignments;
    if(!list.some(a=>a.name==='historyTriggerKind'))list.push({id:uuid(name+'historyTriggerKind'),name:'historyTriggerKind',value,type:'string'});
  }
  const assignments=c.nodes.find(n=>n.name==='Build Candidate Query Config').parameters.assignments.assignments;
  if(!assignments.some(a=>a.name==='historyTriggerKind'))assignments.push({id:uuid('history-trigger-kind'),name:'historyTriggerKind',value:'={{ $json.historyTriggerKind }}',type:'string'});
  if(!c.nodes.some(n=>n.name==='Register Daily History')){
    const b=new Workflow(['integration','unused','daily-history']);b.call('Register Daily History',inventory[7][2]);const n=b.nodes[0];n.parameters.mode='each';n.parameters.options.waitForSubWorkflow=false;n.parameters.workflowInputs.value.payload="={{ { request: $json, triggerKind: $('Build Candidate Query Config').first().json.historyTriggerKind } }}";c.nodes.push(n);
    c.connections['Build Orchestrator Requests'].main[0].push({node:n.name,type:'main',index:0});
    const codeName='Prepare Root Identity Update';const file='nodes/Prepare_Root_Identity_Update/buildIdentity.js';
    c.nodes.push({id:uuid(codeName),name:codeName,type:'n8n-nodes-base.code',typeVersion:2,position:[7480,900],parameters:{jsCode:`__EXTERNAL_FILE__://${file}`}});
    const update={id:uuid('Update Root Identity'),name:'Update Root Identity',type:'n8n-nodes-base.slack',typeVersion:2.3,position:[7740,900],parameters:{resource:'message',operation:'update',channelId:{__rl:true,mode:'id',value:'={{ $json.channel }}'},ts:'={{ $json.threadTS }}',text:'={{ $json.text }}',updateFields:{}},credentials:slackCredentials()};c.nodes.push(update);c.connections['Build Orchestrator Requests'].main[0].push({node:codeName,type:'main',index:0});c.connections[codeName]={main:[[{node:update.name,type:'main',index:0}]]};
  }
  c.nodes.find(n=>n.name==='Register Daily History').parameters.workflowId.cachedResultName=inventory[7][0];
  c.nodes.find(n=>n.name==='Update Root Identity').webhookId ||= uuid('Update Root Identity:webhook');
  const rootNode=c.nodes.find(n=>n.name==='Prepare Root Identity Update');
  rootNode.parameters.jsCode='__EXTERNAL_FILE__://nodes/Prepare_Root_Identity_Update/buildIdentity.js';
  c.connections['Build Orchestrator Requests'].main[0]=c.connections['Build Orchestrator Requests'].main[0].filter(edge=>edge.node!==rootNode.name);
  if(!c.connections['Reassemble Resolver Output'].main[0].some(edge=>edge.node===rootNode.name))c.connections['Reassemble Resolver Output'].main[0].push({node:rootNode.name,type:'main',index:0});
  fs.writeFileSync(collectorPath,JSON.stringify(c,null,2)+'\n');
}
if (require.main === module) { writer(); importer(); ingest(); lookup(); notify(); deliver(); reply(); register(); if(process.argv.includes('--integrate'))integrate(); }
module.exports = { inventory, Workflow, uuid };
