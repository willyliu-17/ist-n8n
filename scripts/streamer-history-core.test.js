const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./streamer-history-core');
const schema = require('./streamer-history-schema');
function request(overrides = {}) {
  return { id: 1, canonicalRowID: '1', reconciliationStatus: 'canonical', channel: H.CHANNEL,
    requestKey: 'bot-summary:1790000000.000001:1000:1001', requestType: 'standalone_summary',
    createdAtIso: '2026-09-21T00:00:00.000Z', updatedAtIso: '2026-09-21T01:00:00.000Z', status: 'completed', threadTS: '1790000000.000000',
    orderedStreamsJson: JSON.stringify(['previous', 'current'].map((role, i) => ({ role, liveStreamID: String(1000 + i), mode: i ? 'fromStart' : 'fromEnd', durationMinutes: 5, streamContext: { userID: 'user-a', deviceModel: 'model-a' } }))),
    inferenceResultJson: JSON.stringify({ report: { summary: { responsibility_category_list: [H.THERMAL] } } }), ...overrides };
}
const persisted = (v, id = 1) => ({ ...v, ...(v.identityVersion ? { firstSeenAtIso: '2026-10-06T00:00:00.000Z', lastSeenAtIso: '2026-10-06T00:00:00.000Z' } : {}), id, canonicalRowID: String(id), reconciliationStatus: 'canonical', updatedAtIso: '2026-10-06T00:00:00.000Z' });
test('formal cutoff and canonical source filtering do not infer negative labels', () => {
  for (const change of [{ channel: 'C0A4JJJKJMD' }, { createdAtIso: '2026-09-07T15:59:59Z' }, { canonicalRowID: '2' }]) assert.equal(H.records(request(change)).length, 0);
  const ops = H.records(request({ inferenceResultJson: '', status: 'manual_review' }));
  assert.ok(ops.some(o => o.table === H.TABLES.state));
  assert.ok(!ops.some(o => o.table === H.TABLES.analyses));
});
test('event views differ, repeated requests retain distinct analyses', () => {
  const r = request(), one = request({ orderedStreamsJson: JSON.stringify(JSON.parse(r.orderedStreamsJson).slice(1)) });
  assert.notEqual(H.identity(r).eventKey, H.identity(one).eventKey);
  const r2 = request({ id: 2, canonicalRowID: '2', requestKey: 'another-request' });
  assert.equal(H.identity(r).eventKey, H.identity(r2).eventKey);
  assert.notEqual(H.records(r).at(-1).key, H.records(r2).at(-1).key);
  const changed = JSON.parse(r.orderedStreamsJson); changed[0].durationMinutes = 10;
  assert.notEqual(H.records(r).at(-1).key, H.records(request({ orderedStreamsJson: JSON.stringify(changed) })).at(-1).key);
});
test('conflicting or missing identities fail closed', () => {
  const s = JSON.parse(request().orderedStreamsJson); s[0].streamContext.userID = 'other';
  assert.throws(() => H.identity(request({ orderedStreamsJson: JSON.stringify(s) })), /identity_conflict/);
  delete s[0].streamContext.userID;
  assert.throws(() => H.identity(request({ orderedStreamsJson: JSON.stringify(s) })), /missing_user_id/);
});
test('missing inline identity uses only canonical jobs for the same request and stream role', () => {
  const r = request();
  const ordered = JSON.parse(r.orderedStreamsJson);
  delete ordered[0].streamContext.userID;
  r.orderedStreamsJson = JSON.stringify(ordered);
  const job = { id: 7, canonicalRowID: '7', reconciliationStatus: 'canonical', requestKey: r.requestKey, streamID: '1000', role: 'previous', streamContextJson: '{"userID":"user-a"}' };
  assert.equal(H.needsJobContext(r), true);
  assert.equal(H.identity(r, [job]).userID, 'user-a');
  assert.throws(() => H.identity(r, [{ ...job, requestKey: 'other-request' }]), /missing_user_id/);
  assert.throws(() => H.identity(r, [{ ...job, role: 'current' }]), /missing_user_id/);
  assert.throws(() => H.identity(r, [{ ...job, canonicalRowID: '8' }]), /missing_user_id/);
});
test('all emitted values fit schema, no secrets or IP metadata is copied', () => {
  for (const op of H.records(request())) {
    const names = schema[op.table].map(c => c.name);
    for (const name of Object.keys(op.values)) assert.ok(names.includes(name), name);
  }
  const s = JSON.parse(request().orderedStreamsJson); s[0].streamContext.publicIP = 'secret-address';
  assert.ok(!JSON.stringify(H.records(request({ orderedStreamsJson: JSON.stringify(s) }))).includes('secret-address'));
});
test('CAS rejects duplicates and immutable drift; zero update cannot verify', () => {
  const op = H.records(request())[0], row = persisted(op.values);
  assert.equal(H.planWrite(op, [row], row.updatedAtIso).action, 'noop');
  assert.throws(() => H.planWrite(op, [row, row], row.updatedAtIso), /duplicate/);
  assert.throws(() => H.planWrite(op, [{ ...row, userID: 'other' }], row.updatedAtIso), /immutable/);
  assert.throws(() => H.verifyWrite(op, []), /not_verified/);
  const pending = { ...row, canonicalRowID: '', reconciliationStatus: 'pending' };
  const update = H.planWrite(op, [pending], row.updatedAtIso);
  assert.equal(update.action, 'update');
  assert.ok(update.conditions.some(c => c.keyName === 'updatedAtIso'));
  assert.ok(update.conditions.some(c => c.keyName === 'canonicalRowID'));
});
test('human classifications override AI without mutating it, conflicts need explicit supersession', () => {
  const a = H.records(request()).at(-1).values;
  const first = persisted({ reviewID: 'r1', eventKey: a.eventKey, analysisKey: a.analysisKey, reviewType: 'accept_ai', humanCategoriesJson: a.aiCategoriesJson });
  const a2 = { ...a, analysisKey: 'a2' };
  const second = persisted({ reviewID: 'r2', eventKey: a.eventKey, analysisKey: 'a2', reviewType: 'reclassify', humanCategoriesJson: '["App Crash"]' }, 2);
  assert.equal(H.resolveReviews([a, a2], [first, second]).conflict, true);
  const result = H.resolveReviews([a, a2], [first, { ...second, supersedesReviewID: 'r1' }]);
  assert.equal(result.conflict, false); assert.deepEqual(result.categories, ['App Crash']);
  assert.equal(a.aiCategoriesJson, JSON.stringify([H.THERMAL]));
});
test('history shows request date, event IDs, trigger link and categories; excludes current request', () => {
  const data = { events: [], streams: [], analyses: [], state: [], reviews: [] };
  for (const op of H.records(request())) data[Object.keys(H.TABLES).find(k => H.TABLES[k] === op.table)].push(persisted(op.values));
  const out = H.lookup({ userID: 'user-a' }, data);
  assert.equal(out.eventCount, 1); assert.equal(out.analysisCount, 1);
  const text = out.pages.join('');
  for (const value of ['1000 → 1001', 'p1790000000000001', H.THERMAL, '請求時間']) assert.ok(text.includes(value));
  assert.ok(!text.includes('p1790000000000000'));
  assert.equal(H.lookup({ userID: 'user-a', excludeRequestKey: request().requestKey }, data).analysisCount, 0);
});
test('identity keys are stable across object key order and locked to v1 vectors', () => {
  assert.equal(H.key('fixture', ['x', { b: 2, a: 1 }]), H.key('fixture', ['x', { a: 1, b: 2 }]));
  assert.equal(H.key('event', ['production', 'fixture-user', [['current', '1001']]]), 'event:v1:f625c48eae808cb2');
});
test('CAS claims cannot recreate missing rows or steal a changed snapshot', () => {
  const op = H.operation(H.TABLES.state, 'stateKey', { stateKey: 'notification', deliveryStatus: 'sending', deliveryToken: 'owner-a' }, ['deliveryStatus', 'deliveryToken']);
  op.expected = { deliveryStatus: 'pending', updatedAtIso: '2026-10-06T00:00:00.000Z' };
  assert.throws(() => H.planWrite(op, [], '2026-10-06T01:00:00.000Z'), /cas_snapshot_missing/);
  const row = persisted({ stateKey: 'notification', deliveryStatus: 'sending', deliveryToken: 'owner-b' });
  assert.throws(() => H.planWrite(op, [row], '2026-10-06T01:00:00.000Z'), /cas_snapshot_changed/);
  assert.throws(() => H.verifyWrite(op, [row]), /write_not_verified/);
});
test('registering an existing daily request never resets sent or unknown delivery', () => {
  const op = H.operation(H.TABLES.state, 'stateKey', { stateKey: 'notification', sourceRequestKey: 'request-a', deliveryStatus: 'pending', deliveryToken: '', deliveryMessageTS: '' });
  op.createOnly = true;
  for (const status of ['sent', 'sending']) {
    const row = persisted({ ...op.values, deliveryStatus: status, deliveryToken: 'previous-owner', deliveryMessageTS: status === 'sent' ? '1790000000.000001' : '' });
    assert.equal(H.planWrite(op, [row], '2026-10-06T01:00:00.000Z').action, 'noop');
  }
});
test('watermarks cannot regress after an overlapping run', () => {
  const op = H.operation(H.TABLES.state, 'stateKey', { stateKey: 'watermark', watermarkUpdatedAtIso: '2026-10-01T00:00:00Z' }, ['watermarkUpdatedAtIso']);
  assert.throws(() => H.planWrite(op, [persisted({ ...op.values, watermarkUpdatedAtIso: '2026-10-02T00:00:00Z' })], '2026-10-06T00:00:00Z'), /stale_source/);
});
test('event observation timestamps preserve first seen and advance last seen without a new event', () => {
  const op = H.records(request())[0];
  const first = H.planWrite(op, [], '2026-10-05T00:00:00Z');
  const row = { ...first.values, id: 1, canonicalRowID: '1', reconciliationStatus: 'canonical' };
  const next = H.planWrite(op, [row], '2026-10-06T00:00:00Z');
  assert.equal(next.values.firstSeenAtIso, '2026-10-05T00:00:00Z');
  assert.equal(next.values.lastSeenAtIso, '2026-10-06T00:00:00Z');
  assert.equal(next.values.eventKey, row.eventKey);
});
test('accept-AI reviews apply only to their exact analysis version', () => {
  const a = H.records(request()).at(-1).values;
  const next = { ...a, analysisKey: 'next-version' };
  const review = persisted({ reviewID: 'review-1', eventKey: a.eventKey, analysisKey: a.analysisKey, reviewType: 'accept_ai', humanCategoriesJson: a.aiCategoriesJson });
  assert.equal(H.resolveReviews([a, next], [review], a.analysisKey).reviewed, true);
  assert.equal(H.resolveReviews([a, next], [review], next.analysisKey).reviewed, false);
  assert.throws(() => H.resolveReviews([a], [{ ...review, humanCategoriesJson: '["App Crash"]' }]), /accept_mismatch/);
});
test('daily lookup waits for a watermark covering its cutoff', () => {
  const data = { events: [], streams: [], analyses: [], state: [persisted({ recordType: 'watermark', watermarkUpdatedAtIso: '2026-09-20T00:00:00Z' })], reviews: [] };
  const out = H.lookup({ userID: 'user-a', presentationMode: 'daily_completed', beforeIso: '2026-10-01T00:00:00Z' }, data);
  assert.equal(out.historyStatus, 'not_ready');
  assert.ok(out.pages.join('').includes('不能判定沒有歷史'));
  data.state.push({ ...data.state[0] });
  assert.throws(() => H.lookup({ userID: 'user-a' }, data), /watermark_conflict|duplicate_key/);
});
test('lookup detects missing event-stream rows instead of presenting partial counts', () => {
  const data = { events: [], streams: [], analyses: [], state: [], reviews: [] };
  for (const op of H.records(request())) data[Object.keys(H.TABLES).find(k => H.TABLES[k] === op.table)].push(persisted(op.values));
  data.streams.pop();
  assert.throws(() => H.lookup({ userID: 'user-a' }, data), /index_incomplete/);
});
function historyData(requests) {
  const maps = Object.fromEntries(Object.keys(H.TABLES).map(k => [k, new Map()]));
  let id = 1;
  for (const r of requests) for (const op of H.records(r)) {
    maps[Object.keys(H.TABLES).find(k => H.TABLES[k] === op.table)].set(op.key, persisted(op.values, id++));
  }
  return Object.fromEntries(Object.entries(maps).map(([k, rows]) => [k, [...rows.values()]]));
}
test('only completed daily thermal summaries reach history lookup', () => {
  const r = request({summaryMessageTS:'1790000000.000001',summaryUploadID:'F-result'});
  const marker = {recordType:'notification',triggerKind:'daily',sourceRequestKey:r.requestKey,channel:r.channel,threadTS:r.threadTS,userID:'user-a'};
  assert.deepEqual(H.deliveryDecision(r,marker), {action:'lookup',userID:'user-a',thermalOnly:true,presentationMode:'daily_completed',beforeIso:r.createdAtIso,excludeRequestKey:r.requestKey});
  for(const status of ['pending','failed','summary_dispatching'])assert.equal(H.deliveryDecision({...r,status},marker).action,'wait');
  assert.equal(H.deliveryDecision({...r,summaryUploadID:''},marker).action,'wait');
  assert.equal(H.deliveryDecision({...r,inferenceResultJson:JSON.stringify({report:{summary:{responsibility_category_list:['[1-d] App Crash']}}})},marker).action,'skip');
  assert.throws(()=>H.deliveryDecision({...r,inferenceResultJson:'{}'},marker),/invalid_categories/);
  assert.throws(()=>H.deliveryDecision(r,{...marker,triggerKind:'manual'}),/identity_conflict/);
});
test('thermal history includes formal manual results and excludes nonthermal, current and future results', () => {
  const thermal=request();
  const repeat=request({id:2,canonicalRowID:'2',requestKey:'bot-summary:1790000000.000002:1000:1001',createdAtIso:'2026-09-22T00:00:00Z'});
  const nonthermal=request({id:3,canonicalRowID:'3',requestKey:'other',inferenceResultJson:JSON.stringify({report:{summary:{responsibility_category_list:['App Crash']}}})});
  const current=request({id:4,canonicalRowID:'4',requestKey:'current',createdAtIso:'2026-09-23T00:00:00Z'});
  const future=request({id:5,canonicalRowID:'5',requestKey:'future',createdAtIso:'2026-09-24T00:00:00Z'});
  const data=historyData([thermal,repeat,nonthermal,current,future]);
  data.state.push(persisted({stateKey:'watermark:production:summary',recordType:'watermark',watermarkUpdatedAtIso:'2026-09-25T00:00:00Z'},99));
  const result=H.lookup({userID:'user-a',presentationMode:'daily_completed',thermalOnly:true,beforeIso:current.createdAtIso,excludeRequestKey:'current'},data);
  assert.equal(result.analysisCount,2);assert.equal(result.eventCount,1);assert.equal(result.thermalEvents,1);
  const text=result.pages.join('');assert.ok(text.includes('正式手動 summary'));assert.ok(text.includes('同事件的多次分析'));assert.ok(!text.includes('App Crash'));
  assert.equal(text.split('StreamID：').length-1,1);
  assert.equal(H.lookup({userID:'user-a'},data).analysisCount,5);
});
test('thermal history respects explicit human reclassification without losing the original AI record', () => {
  const data=historyData([request()]);const analysis=data.analyses[0];
  data.reviews.push(persisted({reviewID:'r1',eventKey:analysis.eventKey,analysisKey:analysis.analysisKey,reviewType:'reclassify',humanCategoriesJson:'["App Crash"]'},98));
  data.state.push(persisted({stateKey:'watermark',recordType:'watermark',watermarkUpdatedAtIso:'2026-10-01T00:00:00Z'},99));
  const result=H.lookup({userID:'user-a',thermalOnly:true,presentationMode:'daily_completed',beforeIso:'2026-09-30T00:00:00Z'},data);
  assert.equal(result.analysisCount,0);assert.ok(result.pages.join('').includes('查無過往高 CPU／過熱相關紀錄'));
  assert.equal(data.analyses[0].aiCategoriesJson,JSON.stringify([H.THERMAL]));
});
test('category facts flatten all labels once per analysis and retain honest time provenance', () => {
  const r=request({createdAtIso:'2026-09-20T16:01:00Z',summaryMessageTS:'1790000000.123456',inferenceResultJson:JSON.stringify({report:{summary:{responsibility_category_list:[H.THERMAL,'App Crash',H.THERMAL]}}})});
  const ops=H.records(r);const facts=H.categoryRecords(r,ops);
  assert.equal(facts.length,2);assert.equal(new Set(facts.map(f=>f.key)).size,2);
  for(const op of facts){assert.equal(op.table,H.CATEGORY_TABLE);assert.equal(op.values.analysisKey,ops.at(-1).values.analysisKey);assert.equal(op.values.triggerKind,'manual');assert.equal(op.values.requestDateTW,'2026-09-21');assert.equal(op.values.summaryCompletedAtIso,'');assert.equal(op.values.completionTimeEvidence,'not_recorded');assert.equal(op.values.currentStreamID,'1001');assert.ok(op.values.summaryMessageAtIso);for(const k of Object.keys(op.values))assert.ok(schema[op.table].some(c=>c.name===k));}
  assert.deepEqual(H.categoryRecords(r,ops),facts);
  const unknown=request({requestType:'suspect_summary',requestKey:'suspect-request'});
  assert.equal(H.categoryRecords(unknown,H.records(unknown))[0].values.triggerKind,'unknown');
  const marker=persisted({recordType:'notification',triggerKind:'daily',sourceRequestKey:unknown.requestKey,channel:unknown.channel,threadTS:unknown.threadTS,userID:'user-a'});
  const daily=H.categoryRecords(unknown,H.records(unknown),[marker])[0];assert.equal(daily.values.triggerKind,'daily');
  assert.throws(()=>H.categoryRecords(unknown,H.records(unknown),[marker,marker]),/provenance_conflict/);
  assert.throws(()=>H.categoryRecords(unknown,H.records(unknown),[{...marker,userID:'other'}]),/provenance_conflict/);
  const old=H.categoryRecords(unknown,H.records(unknown))[0];assert.equal(H.planWrite(daily,[persisted(old.values)],'2026-10-20T00:00:00Z').action,'update');
  assert.throws(()=>H.planWrite(old,[persisted(daily.values)],'2026-10-20T00:00:00Z'),/provenance_regression/);
  assert.deepEqual(H.categoryRecords(request({inferenceResultJson:''}),H.records(request({inferenceResultJson:''}))),[]);
});
