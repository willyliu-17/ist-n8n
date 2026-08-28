const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const helper = require('../nodes/Finalize_Request/jsCode');
const { buildInferenceAggregate } = require('../nodes/group_streamID/jsCode');
const { renderSummaryMarkdown } = require('../nodes/Render_Summary_Markdown/jsCode');
const { buildEventQueryItems } = require('../nodes/Build_Event_Query_Items/jsCode');
const { parseSlackResponse } = require('../nodes/Parse_Slack_Response/jsCode');
const { mapSummaryReactions } = require('../nodes/Map_Summary_Reactions/jsCode');

const root = path.resolve(__dirname, '..');
const workflow = JSON.parse(fs.readFileSync(path.join(root, 'workflow.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'workflow.json'), 'utf8');
const NOW = new Date('2099-01-01T00:00:00.000Z');
function input(overrides = {}) { return { requestKey: 'summary:req-1', requestType: 'suspect', channel: 'C0A4JJJKJMD', threadTS: '1787364000.000001', coverageStatus: 'complete', availableRoles: ['current'], missingRoles: [], failedLogicalJobKeys: [], streams: [{ role: 'current', liveStreamID: '9', mode: 'fromStart', dialogue: 'hello', streamContext: { userID: 'user-9', device: 'ios', beginTime: 1787360400, endTime: 1787364000 } }], ...overrides }; }
function row(overrides = {}) { const data = input(); const { id = 301, canonicalRowID, ...rest } = overrides; return { id, requestKey: data.requestKey, requestType: data.requestType, status: 'summary_dispatching', reconciliationStatus: 'canonical', canonicalRowID: canonicalRowID === undefined ? String(id) : String(canonicalRowID), channel: data.channel, threadTS: data.threadTS, coverageStatus: data.coverageStatus, availableRolesJson: JSON.stringify(data.availableRoles), missingRolesJson: JSON.stringify(data.missingRoles), failedLogicalJobKeysJson: JSON.stringify(data.failedLogicalJobKeys), leaseOwner: 'exec-1', leaseUntilIso: '2099-01-01T00:05:00.000Z', summaryAttempt: 0, createdAtIso: '2099-01-01T00:00:00.000Z', ...rest }; }
function node(name) { return workflow.nodes.find((item) => item.name === name); }

test('has exactly one typed Execute Workflow Trigger with nine fields', () => { const triggers = workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.executeWorkflowTrigger'); assert.equal(triggers.length, 1); assert.deepEqual(triggers[0].parameters.workflowInputs.values.map((item) => item.name), ['requestKey', 'requestType', 'channel', 'threadTS', 'coverageStatus', 'availableRoles', 'missingRoles', 'failedLogicalJobKeys', 'streams']); });
test('forbids manual, webhook, wait, direct STT, metadata, and legacy table', () => { for (const forbidden of ['manualTrigger', 'webhook', 'n8n-nodes-base.wait', 'stt-api', 'query stream info', 'AISummaryV2', 'Insert row']) assert.equal(source.includes(forbidden), false, forbidden); });
test('only event evidence BigQuery names may remain', () => { const bq = workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.googleBigQuery'); assert.ok(bq.every((item) => ['StreamerLog', 'StreamerEventLog'].includes(item.name))); });
test('workflow is inactive with approved execution retention', () => { assert.equal(workflow.active, false); assert.deepEqual(workflow.settings, { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true, saveExecutionProgress: false }); });
test('all node ids are UUIDs and connections resolve', () => { const names = new Set(workflow.nodes.map((item) => item.name)); workflow.nodes.forEach((item) => assert.match(item.id, /^[0-9a-f-]{36}$/)); Object.entries(workflow.connections).forEach(([from, outputs]) => { assert.ok(names.has(from)); Object.values(outputs).flat().flat().forEach((edge) => assert.ok(names.has(edge.node))); }); });
test('external references resolve to existing files', () => { for (const match of source.matchAll(/__EXTERNAL_FILE__:\/\/([^"\\]+?)(?:"|\\n)/g)) assert.ok(fs.existsSync(path.join(root, match[1]))); });
test('accepts valid resolved input', () => assert.equal(helper.validateInput(input()).requestKey, 'summary:req-1'));
test('rejects missing input field', () => { const value = input(); delete value.streams; assert.throws(() => helper.validateInput(value)); });
test('rejects extra input field', () => assert.throws(() => helper.validateInput({ ...input(), extra: true })));
test('rejects wrong channel', () => assert.throws(() => helper.validateInput(input({ channel: 'Cbad' }))));
test('rejects invalid Slack timestamp', () => assert.throws(() => helper.validateInput(input({ threadTS: 'bad' }))));
test('rejects all_failed coverage', () => assert.throws(() => helper.validateInput(input({ coverageStatus: 'all_failed' }))));
test('rejects empty streams', () => assert.throws(() => helper.validateInput(input({ streams: [] }))));
test('accepts empty transcription dialogue and rejects non-string dialogue', () => {
  const empty = input({ streams: [{ ...input().streams[0], dialogue: '' }] });
  assert.equal(helper.validateInput(empty).streams[0].dialogue, '');
  const aggregate = buildInferenceAggregate(empty, [
    { liveStreamID: '9', evidenceType: 'streamerLog', message: 'comment evidence' },
  ]);
  assert.equal(aggregate.streams[0].details[0].dialogue, '');
  assert.equal(aggregate.streams[0].details.some(({ type }) => type === 'streamerLog'), true);
  assert.throws(() => helper.validateInput(input({ streams: [{ ...input().streams[0], dialogue: null }] })));
});
test('rejects stream with invalid mode', () => assert.throws(() => helper.validateInput(input({ streams: [{ ...input().streams[0], mode: 'bad' }] }))));
test('rejects array streamContext', () => assert.throws(() => helper.validateInput(input({ streams: [{ ...input().streams[0], streamContext: [] }] }))));
test('rejects invalid streamContext time windows', () => {
  assert.throws(() => helper.validateInput(input({ streams: [{ ...input().streams[0], streamContext: { beginTime: '1787360400', endTime: 1787364000 } }] })));
  assert.throws(() => helper.validateInput(input({ streams: [{ ...input().streams[0], streamContext: { beginTime: 1787364001, endTime: 1787364000 } }] })));
});
test('builds event query items with exact stream context fields', () => {
  const carrier = { kind: 'carrier', nextStage: 'inference', input: input() };
  const [item] = buildEventQueryItems(carrier);

  assert.equal(item.kind, 'event_query');
  assert.equal(item.carrier, carrier);
  assert.deepEqual(
    {
      liveStreamID: item.liveStreamID,
      userID: item.userID,
      beginTime: item.beginTime,
      endTime: item.endTime,
    },
    {
      liveStreamID: '9',
      userID: 'user-9',
      beginTime: 1787360400,
      endTime: 1787364000,
    },
  );
});

test('fails event query construction when streamContext userID is missing or blank', () => {
  for (const userID of [undefined, '', '   ']) {
    const value = input();
    value.streams[0].streamContext = { ...value.streams[0].streamContext, userID };
    const carrier = { kind: 'carrier', nextStage: 'inference', input: value };
    assert.throws(() => buildEventQueryItems(carrier), /streamContext\.userID/);
  }
});
test('requires an exact canonical self-link', () => assert.throws(() => helper.reconcile([row({ canonicalRowID: '' })], input())));
test('requires a positive numeric system row id and string canonical reference', () => {
  assert.throws(() => helper.reconcile([{ ...row(), id: '301', canonicalRowID: '301' }], input()), /system row id/);
  assert.throws(() => helper.reconcile([{ ...row(), canonicalRowID: 301 }], input()), /self-link/);
});
test('requires summary_dispatching status', () => assert.throws(() => helper.reconcile([row({ status: 'ready' })], input())));
test('requires owner and unexpired lease', () => { assert.throws(() => helper.reconcile([row({ leaseOwner: '' })], input())); assert.throws(() => helper.reconcile([row({ leaseUntilIso: '2000-01-01T00:00:00.000Z' })], input())); });
test('rejects persisted coverage drift', () => assert.throws(() => helper.reconcile([row({ availableRolesJson: '[]' })], input())));
test('rejects immutable routing drift', () => assert.throws(() => helper.reconcile([row({ channel: 'Cbad' })], input())));
test('allows owned canonical request', () => assert.equal(helper.reconcile([row()], input()).action, 'owner'));
test('reconciles checkpoint-free competing canonicals', () => assert.equal(helper.reconcile([row(), row({ id: 302, canonicalRowID: '302', createdAtIso: '2099-01-02T00:00:00.000Z' })], input()).action, 'reconcile'));
test('freezes all competing canonical rows on checkpoint conflict', () => { const plan = helper.reconcile([row(), row({ id: 302, canonicalRowID: '302', summaryMarkdown: 'persisted' })], input()); assert.equal(plan.action, 'freeze'); assert.equal(plan.rows.length, 2); });
test('owner conditions contain canonical lease snapshot', () => assert.deepEqual(Object.keys(helper.ownerConditions(row())).sort(), ['canonicalRowID', 'id', 'leaseOwner', 'leaseUntilIso', 'reconciliationStatus', 'requestKey', 'status'].sort()));
test('inference runs when checkpoints are missing', () => assert.equal(helper.stagePlan(row(), 'inference').action, 'side_effect'));
test('inference skips when both checkpoints persist', () => assert.equal(helper.stagePlan(row({ inferenceResultJson: '{}', summaryMarkdown: '# done' }), 'inference').action, 'skip'));
test('upload skips after its checkpoint', () => assert.equal(helper.stagePlan(row({ summaryUploadID: 'F1' }), 'upload').action, 'skip'));
test('message skips after its checkpoint', () => assert.equal(helper.stagePlan(row({ summaryMessageTS: '1.000001' }), 'message').action, 'skip'));
test('inference checkpoint requires both values', () => assert.throws(() => helper.checkpointPlan(row(), 'inference', { inferenceResultJson: '{}' })));
test('upload checkpoint requires upload id', () => assert.throws(() => helper.checkpointPlan(row(), 'upload', {})));
test('message checkpoint requires timestamp', () => assert.throws(() => helper.checkpointPlan(row(), 'message', {})));
test('parses the Slack message timestamp returned by the post operation', () => {
  const carrier = { kind: 'carrier', input: input(), row: row(), nextStage: 'message' };
  const result = parseSlackResponse({ ...carrier, ok: true, message_timestamp: '1787737562.408869', message: { ts: '1787737562.408869' } });
  assert.equal(result.checkpointField, 'summaryMessageTS');
  assert.equal(result.checkpointValue, '1787737562.408869');
});
test('retains support for Slack responses with a top-level ts', () => {
  const carrier = { kind: 'carrier', input: input(), row: row(), nextStage: 'message' };
  assert.equal(parseSlackResponse({ ...carrier, ok: true, ts: '1.000001' }).checkpointValue, '1.000001');
});
test('checkpoint plan retains exact owner conditions', () => assert.equal(helper.checkpointPlan(row(), 'upload', { summaryUploadID: 'F1' }).conditions.leaseOwner, 'exec-1'));
test('first stage failure schedules one minute retry', () => { const plan = helper.failurePlan(row(), 'inference', 'timeout', NOW); assert.equal(plan.values.summaryAttempt, 1); assert.equal(plan.values.nextRetryAtIso, '2099-01-01T00:01:00.000Z'); assert.equal(plan.values.status, 'summary_retry_pending'); });
test('second stage failure schedules five minute retry', () => assert.equal(helper.failurePlan(row({ summaryAttempt: 1 }), 'upload', 'timeout', NOW).values.nextRetryAtIso, '2099-01-01T00:05:00.000Z'));
test('third stage failure is terminal and clears lease', () => { const values = helper.failurePlan(row({ summaryAttempt: 2 }), 'message', 'bad payload', NOW).values; assert.equal(values.status, 'failed'); assert.equal(values.leaseOwner, ''); assert.equal(values.leaseUntilIso, ''); });
test('failure code is bounded and raw payload is excluded', () => { const values = helper.failurePlan(row(), 'upload', 'bad value! https://secret.example/a?token=x', NOW).values; assert.ok(values.errorCode.length <= 96); assert.equal(values.errorCode.includes('https'), false); });
test('completion requires all checkpoints', () => assert.throws(() => helper.completePlan(row())));
test('completion clears lease using CAS', () => { const plan = helper.completePlan(row({ inferenceResultJson: '{}', summaryMarkdown: '# ok', summaryUploadID: 'F1', summaryMessageTS: '1.000001' })); assert.equal(plan.values.status, 'completed'); assert.equal(plan.values.leaseOwner, ''); });
test('verifier rejects stale or partial writes', () => assert.throws(() => helper.verify(row(), { conditions: helper.ownerConditions(row()), values: { status: 'completed' } })));
test('verifier accepts exact persisted write', () => assert.equal(helper.verify(row({ summaryUploadID: 'F1' }), { conditions: helper.ownerConditions(row()), values: { summaryUploadID: 'F1' } }).summaryUploadID, 'F1'));
test('natural result uses the exact allowlist', () => assert.deepEqual(Object.keys(helper.result(row())).sort(), ['coverageStatus', 'requestKey', 'status', 'summaryMessageTS', 'summaryUploadID'].sort()));
test('aggregate uses the inference child stream details contract', () => {
  const aggregate = buildInferenceAggregate(input(), [
    { liveStreamID: '9', evidenceType: 'streamerLog', Type: 'PushReport' },
    { liveStreamID: '9', evidenceType: 'streamEventLog', title: 'RTMP Error' },
  ]);
  assert.equal(aggregate.streams[0].liveStreamID, '9');
  assert.deepEqual(aggregate.streams[0].details.map(({ type }) => type), ['dialogue', 'streamInfo', 'streamerLog', 'streamEventLog']);
  assert.equal(aggregate.streams[0].details.find(({ type }) => type === 'dialogue').dialogue, 'hello');
});
test('aggregate preserves whichever event evidence types are available', () => {
  const streamerOnly = buildInferenceAggregate(input(), [
    { liveStreamID: '9', evidenceType: 'streamerLog', Type: 'PushReport' },
  ]).streams[0].details.map(({ type }) => type);
  const eventOnly = buildInferenceAggregate(input(), [
    { liveStreamID: '9', evidenceType: 'streamEventLog', title: 'RTMP Error' },
  ]).streams[0].details.map(({ type }) => type);
  const neither = buildInferenceAggregate(input(), []).streams[0].details.map(({ type }) => type);

  assert.deepEqual(streamerOnly, ['dialogue', 'streamInfo', 'streamerLog']);
  assert.deepEqual(eventOnly, ['dialogue', 'streamInfo', 'streamEventLog']);
  assert.deepEqual(neither, ['dialogue', 'streamInfo']);
});
test('markdown renderer preserves the original localized report format', () => {
  const markdown = renderSummaryMarkdown({
    report: {
      subjective_motivation: {
        timeline_overview: 'timeline',
        subjective_description: 'description',
        recovery_status: 'recovered',
      },
      sl_analysis: 'streamer log result',
      sel_analysis: 'event log result',
      summary: {
        fact_check: { claimed_issue: 'claim', data_evidence: 'evidence', is_valid_issue: 'Partial' },
        responsibility_category: '[Level 1]',
        responsibility_category_list: ['[1-g] User Interaction Issue'],
        causal_summary: 'cause',
        other_issue: 'other',
        exclusion_reason: { level_1: 'level one', level_2: 'level two' },
      },
    },
  }, 'partial');

  assert.match(markdown, /^# AI SUMMARY/);
  assert.match(markdown, /> Partial coverage/);
  assert.match(markdown, /#### 【主觀動機與時間軸】/);
  assert.match(markdown, /\*\*時間軸概覽\*\*：timeline/);
  assert.match(markdown, /#### 【Streamer Log 分析】/);
  assert.match(markdown, /#### 【Stream Event Log 分析】/);
  assert.match(markdown, /#### 【結論】/);
  assert.match(markdown, /\*\*事實查核\*\*：\n- \*\*主播主觀判定的問題\*\*：claim/);
  assert.match(markdown, /\*\*責任歸屬類別清單\*\*：\n- \[1-g\] User Interaction Issue/);
  assert.match(markdown, /\*\*其他問題\*\*：other/);
  assert.match(markdown, /\*\*排除與判定邏輯\*\*：\n- \*\*Level 1 判定\/排除依據\*\*：level one/);
  assert.doesNotMatch(markdown, /```json|subjective_motivation|responsibility_category_list/);
});
test('markdown renderer rejects invalid report', () => assert.throws(() => renderSummaryMarkdown({}, 'complete')));
test('side effects have continue error output and no retries', () => { for (const name of ['Call AI SUMMARY Inference SubWF', 'Upload Summary File', 'Post Summary Message']) { const item = node(name); assert.equal(item.onError, 'continueErrorOutput'); assert.notEqual(item.retryOnFail, true); } });
test('side effects are ordered inference upload message', () => { const order = ['Call AI SUMMARY Inference SubWF', 'Upload Summary File', 'Post Summary Message'].map((name) => workflow.nodes.indexOf(node(name))); assert.ok(order[0] < order[1] && order[1] < order[2]); });
test('writes use only summary_requests_v3 allConditions and always output', () => workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.dataTable' && item.parameters.operation === 'update').forEach((item) => { assert.equal(item.parameters.dataTableId.value, 'summary_requests_v3'); assert.equal(item.parameters.matchType, 'allConditions'); assert.equal(item.alwaysOutputData, true); }));
test('Data Table id filters stay numeric while canonical filters stringify row ids', () => workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.dataTable' && item.parameters.operation === 'update').forEach((item) => {
  const filters = Object.fromEntries(item.parameters.filters.conditions.map(({ keyName, keyValue }) => [keyName, keyValue]));
  if (filters.id) assert.doesNotMatch(filters.id, /String\(/, item.name);
  if (filters.canonicalRowID && /\$json\.row\.id/.test(filters.canonicalRowID)) assert.match(filters.canonicalRowID, /String\(\$json\.row\.id\)/, item.name);
}));
test('checkpoint writes use Limit 1 and rereads', () => { assert.ok(node('Limit Inference Checkpoint')); assert.ok(node('Verify Inference Checkpoint')); assert.ok(node('Limit Freeze Patch')); assert.ok(node('Re-read Frozen Request')); });
test('summary reactions restore the original category mapping on the original thread', () => {
  const reactions = mapSummaryReactions({
    inferenceResultJson: JSON.stringify({ report: { summary: { responsibility_category_list: ['[1-g] User Interaction Issue', '[2-c] Signal'] } } }),
    orderedStreamsJson: JSON.stringify([{ streamContext: { type: 'ios', deviceModel: 'iPad Pro' } }]),
  });
  assert.deepEqual(reactions.map(({ emoji }) => emoji), ['ipad', 'user', 'signal_strength']);
  const reaction = node('Add Summary Reaction');
  assert.equal(reaction.parameters.resource, 'reaction');
  assert.equal(reaction.parameters.timestamp, '={{ $json.input.threadTS }}');
  assert.equal(reaction.onError, 'continueErrorOutput');
  assert.equal(workflow.connections['Parse Message Response'].main[0].some((edge) => edge.node === 'Map Summary Reactions'), true);
});
test('no historical execution references remain', () => { assert.equal(source.includes('$runIndex'), false); assert.equal(source.includes('isExecuted'), false); });
test('crash windows are explicitly documented', () => assert.match(workflow.description, /may be duplicated during repair/));
test('runtime Code sources are externalized and contain no sibling require', () => { workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.code').forEach((item) => assert.match(item.parameters.jsCode, /^__EXTERNAL_FILE__:\/\//)); assert.equal(source.includes("require('./Finalize_Request/jsCode')"), false); });
test('validated carrier feeds every full stage read through append input zero', () => { const merge = node('Append Stage Carrier And Rows'); assert.equal(merge.parameters.mode, 'append'); assert.equal(merge.parameters.numberInputs, 2); assert.equal(workflow.connections['Build Direct Carrier'].main[0].some((edge) => edge.node === merge.name && edge.index === 0), true); });
test('next-stage planner is the only stage router and has all six terminal actions', () => {
  const router = node('Route Next Stage');
  assert.ok(router);
  assert.equal((workflow.connections['Plan Next Stage'].main[0] || []).some((edge) => edge.node === router.name), true);
  assert.equal(router.parameters.rules.values.length, 6);
  assert.equal(router.parameters.options.fallbackOutput, 'extra');
  for (const rule of router.parameters.rules.values) {
    assert.deepEqual(rule.conditions.options, { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 });
    assert.equal(rule.conditions.combinator, 'and');
  }
});
test('reconciliation has an actual exact write limit reread and verifier', () => ['Reconcile Canonical Exact', 'Limit Reconcile Patch', 'Re-read Reconciled Request', 'Verify Reconciliation'].forEach((name) => assert.ok(node(name))));
test('freeze is terminal after exact write limit reread and verifier', () => ['Freeze Competing Canonicals', 'Limit Freeze Patch', 'Re-read Frozen Request', 'Verify Freeze'].forEach((name) => assert.ok(node(name))));
test('all side effects have an immediately preceding owner preflight', () => [['Preflight Inference Owner', 'StreamerLog'], ['Preflight Upload Owner', 'Upload Summary File'], ['Preflight Message Owner', 'Post Summary Message']].forEach(([preflight, effect]) => assert.ok(workflow.nodes.indexOf(node(preflight)) < workflow.nodes.indexOf(node(effect)))));
test('event queries are connected from streamContext query items and retain credentials', () => { ['StreamerLog', 'StreamerEventLog'].forEach((name) => { const item = node(name); assert.equal(item.credentials.googleApi.id, 'Dd7x1TQhh9YKbD8v'); assert.equal(workflow.connections['Build Event Query Items'].main[0].some((edge) => edge.node === name), true); }); });
test('event evidence waits for carrier and both query branches', () => {
  const merge = node('Merge Event Evidence And Carrier');
  const inputIndex = (sourceName) => workflow.connections[sourceName].main[0]
    .find((edge) => edge.node === merge.name).index;

  assert.deepEqual(merge.parameters, { mode: 'append', numberInputs: 3 });
  assert.equal(inputIndex('Preflight Inference Owner'), 0);
  assert.equal(inputIndex('StreamerLog'), 1);
  assert.equal(inputIndex('StreamerEventLog'), 2);
  assert.equal(node('StreamerLog').alwaysOutputData, true);
  assert.equal(node('StreamerEventLog').alwaysOutputData, true);
});
test('StreamerLog projects the requested stream ID instead of the source LiveStreamID', () => {
  const sql = fs.readFileSync(path.join(root, 'nodes', 'StreamerLog', 'sqlQuery.sql'), 'utf8');

  assert.match(sql, /@liveStreamID AS liveStreamID/);
  assert.doesNotMatch(sql, /LiveStreamID AS liveStreamID/);
  assert.match(sql, /Suid = @liveStreamID/);
});
test('EventLog uses parameterized user matching and preserves the five-minute window', () => {
  const sql = fs.readFileSync(path.join(root, 'nodes', 'StreamerEventLog', 'sqlQuery.sql'), 'utf8');
  const streamerNode = node('StreamerLog');
  const eventNode = node('StreamerEventLog');

  assert.doesNotMatch(sql, /\bSuid\b/);
  assert.match(sql, /@liveStreamID AS liveStreamID/);
  assert.match(sql, /triggerUserID LIKE CONCAT\('%', @userID, '%'\)/);
  assert.match(sql, /TIMESTAMP_ADD\(TIMESTAMP_SECONDS\(\{\{ \$json\.endTime \}\}\), INTERVAL 5 MINUTE\)/);
  assert.match(sql, /TIMESTAMP_SUB\(TIMESTAMP_SECONDS\(\{\{ \$json\.beginTime \}\}\), INTERVAL 5 MINUTE\)/);
  assert.deepEqual(streamerNode.parameters.options.queryParameters.namedParameters, [
    { name: 'liveStreamID', value: '={{ $json.liveStreamID }}' },
  ]);
  assert.deepEqual(eventNode.parameters.options.queryParameters.namedParameters, [
    { name: 'liveStreamID', value: '={{ $json.liveStreamID }}' },
    { name: 'userID', value: '={{ $json.userID }}' },
  ]);
  assert.equal('queryReplacement' in streamerNode.parameters.options, false);
  assert.equal('queryReplacement' in eventNode.parameters.options, false);
});
test('side-effect outputs merge back into direct carriers before checkpoint plans', () => [['Call AI SUMMARY Inference SubWF', 'Merge Inference Carrier And Output'], ['Upload Summary File', 'Merge Upload Carrier And Output'], ['Post Summary Message', 'Merge Message Carrier And Output']].forEach(([effect, merge]) => assert.ok(workflow.connections[effect].main[0].some((edge) => edge.node === merge))));
test('all three stage errors route to sanitized failure planning', () => ['Call AI SUMMARY Inference SubWF', 'Upload Summary File', 'Post Summary Message'].forEach((name) => assert.equal(workflow.connections[name].main[1][0].node, 'Sanitize Stage Error')));
test('failure write snapshots attempt checkpoints and has limit reread verifier', () => { ['Failure CAS Exact', 'Limit Failure Patch', 'Re-read Failure Request', 'Verify Failure'].forEach((name) => assert.ok(node(name))); const filters = node('Failure CAS Exact').parameters.filters.conditions.map((item) => item.keyName); assert.ok(filters.includes('summaryAttempt')); assert.ok(filters.includes('leaseOwner')); });
test('checkpoint loop returns its carrier and refreshed row to the stage planner', () => {
  for (const name of ['Verify Inference Checkpoint', 'Verify Upload Checkpoint', 'Verify Message Checkpoint']) {
    assert.equal(workflow.connections[name].main[0].some((edge) => edge.node === 'Read Stage Request' && edge.index === 0), true);
    assert.equal(workflow.connections[name].main[0].some((edge) => edge.node === 'Append Stage Carrier And Rows' && edge.index === 0), true);
  }
});
test('binary is retained through upload carrier and Slack receives data', () => { assert.equal(node('Build Summary File').parameters.jsCode.includes('Prepare_Summary_File'), true); assert.equal(node('Upload Summary File').parameters.binaryPropertyName, 'data'); });
test('Slack nodes retain the pinned credential and C0 thread routing', () => ['Upload Summary File', 'Post Summary Message'].forEach((name) => { const item = node(name); assert.equal(item.credentials.slackApi.id, '9sfslX7caXSFAVUN'); assert.match(JSON.stringify(item.parameters), /C0A4JJJKJMD/); }));
test('summary notification posts a message instead of managing a channel', () => {
  const item = node('Post Summary Message');
  assert.equal(item.parameters.resource, 'message');
  assert.equal(item.parameters.operation, 'post');
  assert.equal(item.parameters.select, 'channel');
});
test('completion has exact write limit reread verifier then allowlisted return', () => ['Complete Request Exact', 'Limit Complete Patch', 'Re-read Completion Request', 'Verify Completion', 'Return Result'].forEach((name) => assert.ok(node(name))));
test('stage loop carries request input explicitly and group_streamID reads carrier.input', () => {
  const code = fs.readFileSync(path.join(root, 'nodes', 'group_streamID', 'jsCode.js'), 'utf8');
  assert.match(code, /carrier\.input/);
  assert.doesNotMatch(code, /\$input\.first\(\)\.json/);
  assert.equal(node('Build Direct Carrier').parameters.jsCode.includes('Build_Direct_Carrier'), true);
});
test('side-effect carriers use the valid combine-by-position runtime contract', () => {
  for (const name of ['Merge Inference Carrier And Output', 'Merge Upload Carrier And Output', 'Merge Message Carrier And Output']) {
    const merge = node(name);
    assert.equal(merge.parameters.mode, 'combine');
    assert.equal(merge.parameters.combineBy, 'combineByPosition');
    assert.equal(merge.parameters.numberInputs, 2);
  }
  assert.equal(workflow.connections['Build Inference Aggregate'].main[0][0].index, 0);
  assert.equal(workflow.connections['Call AI SUMMARY Inference SubWF'].main[0][0].index, 1);
});
test('all preflights and all write verifiers are concrete direct-carrier helpers', () => {
  const names = ['Preflight Inference Owner', 'Preflight Upload Owner', 'Preflight Message Owner', 'Verify Reconciliation', 'Verify Freeze', 'Verify Inference Checkpoint', 'Verify Upload Checkpoint', 'Verify Message Checkpoint', 'Verify Completion', 'Verify Failure'];
  for (const name of names) assert.notEqual(node(name).parameters.jsCode, '__EXTERNAL_FILE__://nodes/Stage_Pass_Through/jsCode.js', name);
});
test('every side effect has full same-key reread, direct carrier append, and owner gate', () => {
  for (const stage of ['Inference', 'Upload', 'Message']) {
    for (const name of [`Read ${stage} Preflight Rows`, `Append ${stage} Preflight Carrier And Rows`, `Preflight ${stage} Owner`]) assert.ok(node(name), name);
    assert.equal(node(`Read ${stage} Preflight Rows`).parameters.returnAll, true);
    assert.equal(workflow.connections[`Append ${stage} Preflight Carrier And Rows`].main[0][0].node, `Preflight ${stage} Owner`);
  }
});
test('checkpoint, failure, and completion writes snapshot all owner and checkpoint fields then merge original plans into rereads', () => {
  const writes = ['Checkpoint Inference Exact', 'Checkpoint Upload Exact', 'Checkpoint Message Exact', 'Failure CAS Exact', 'Complete Request Exact'];
  for (const name of writes) {
    const keys = node(name).parameters.filters.conditions.map(({ keyName }) => keyName);
    for (const key of ['id', 'requestKey', 'status', 'reconciliationStatus', 'canonicalRowID', 'leaseOwner', 'leaseUntilIso']) assert.ok(keys.includes(key), `${name}: ${key}`);
  }
  for (const stage of ['Inference', 'Upload', 'Message', 'Failure', 'Completion']) {
    const merge = node(`Merge ${stage} Plan And Reread`);
    assert.deepEqual(merge.parameters, { mode: 'append', numberInputs: 2 });
    assert.equal(workflow.connections[`Re-read ${stage} Request`].main[0][0].index, 1);
  }
});
test('Slack outputs are parsed before exact checkpoint writes and summary file uses verified row markdown', () => {
  for (const name of ['Parse Upload Response', 'Parse Message Response']) assert.ok(node(name));
  const file = fs.readFileSync(path.join(root, 'nodes', 'Prepare_Summary_File', 'jsCode.js'), 'utf8');
  assert.match(file, /input\.row\.summaryMarkdown/);
  assert.match(file, /input\.input\.requestKey/);
});
test('reconciliation and freeze mutate every planned row and freeze is terminal', () => {
  const plan = helper.reconcile([row(), row({ id: 302, canonicalRowID: '302' })], input());
  assert.ok(Array.isArray(plan.mutations));
  assert.equal(plan.mutations.length, 1);
  for (const name of ['Reconcile Canonical Exact', 'Freeze Competing Canonicals']) assert.match(JSON.stringify(node(name).parameters.filters.conditions), /expectedStatus/);
  assert.deepEqual(workflow.connections['Verify Freeze'].main[0], [{ node: 'Return Result', type: 'main', index: 0 }]);
});
test('workflow uses approved execution retention settings', () => {
  assert.deepEqual(workflow.settings, { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true, saveExecutionProgress: false });
});
test('success planners consume actual append carrier plus latest rows and reject stale owners', () => {
  const { planWrite } = require('../nodes/Plan_Write.js');
  const carrier = { kind: 'carrier', input: input(), row: row(), ownerConditions: helper.ownerConditions(row()), nextStage: 'upload', checkpointValue: 'F08ABC123' };
  const plan = planWrite([carrier, row()]);
  assert.equal(plan.values.summaryUploadID, 'F08ABC123');
  assert.deepEqual(planWrite([{ ...carrier, nextStage: 'complete' }, row()]).values, { status: 'completed', leaseOwner: '', leaseUntilIso: '' });
  assert.throws(() => planWrite([carrier, row({ leaseOwner: 'other' })]));
});
test('failure planner uses the sanitized explicit stage and latest row attempt schedule', () => {
  const { planFailure } = require('../nodes/Plan_Failure.js');
  const failure = { kind: 'failure_carrier', input: input(), row: row({ summaryAttempt: 1 }), ownerConditions: helper.ownerConditions(row({ summaryAttempt: 1 })), failureStage: 'upload', errorCode: 'upload_failed' };
  const plan = planFailure([failure, row({ summaryAttempt: 1 })], NOW);
  assert.deepEqual(plan.values, { summaryAttempt: 2, status: 'summary_retry_pending', nextRetryAtIso: '2099-01-01T00:05:00.000Z', leaseOwner: '', leaseUntilIso: '', errorCode: 'upload_failed' });
  assert.equal(planFailure([{ ...failure, row: row({ summaryAttempt: 2 }) }, row({ summaryAttempt: 2 })], NOW).values.status, 'failed');
});
test('parses actual single-item combine-by-position Slack 2.3 upload and message results', () => {
  const { parseSlackResponse } = require('../nodes/Parse_Slack_Response/jsCode.js');
  const upload = parseSlackResponse({ kind: 'carrier', input: input(), row: row(), nextStage: 'upload', id: 'F08ABC123', name: 'summary.md' });
  assert.equal(upload.checkpointValue, 'F08ABC123');
  const message = parseSlackResponse({ kind: 'carrier', input: input(), row: row(), nextStage: 'message', ts: '1787364002.000001', text: 'Summary report uploaded.' });
  assert.equal(message.checkpointValue, '1787364002.000001');
  assert.throws(() => parseSlackResponse({ kind: 'carrier', input: input(), row: row(), nextStage: 'upload', ok: false, error: 'bad' }));
});
test('BigQuery casing and child aggregate contract are normalized at the runtime boundary', () => {
  assert.equal(buildInferenceAggregate(input(), [{ LiveStreamID: '9', evidenceType: 'streamerLog' }]).streams[0].details.find(({ type }) => type === 'streamerLog').logs.length, 1);
  const child = JSON.parse(fs.readFileSync(path.resolve(root, '..', 'ai_summary_inference_subwf_m8VcIoclFE2lVKrl', 'workflow.json'), 'utf8'));
  assert.equal(child.nodes.find(({ name }) => name === 'Start').parameters.workflowInputs.values.find(({ name }) => name === 'aggregateData').type, 'array');
  assert.equal(node('Call AI SUMMARY Inference SubWF').parameters.workflowInputs.value.aggregateData, '={{ $json.aggregate.streams }}');
  for (const file of ['AI_Agent', 'Streamer_Log_Analyzer', 'Event_Log_Analyzer', 'Dialogue_Analyzer', 'StreamInfo_Analyzer']) {
    const prompt = fs.readFileSync(path.resolve(root, '..', 'ai_summary_inference_subwf_m8VcIoclFE2lVKrl', 'nodes', file, 'text.md'), 'utf8');
    if (file === 'AI_Agent') assert.match(prompt, /item\.liveStreamID/);
    else assert.match(prompt, /item\.details/);
  }
  assert.match(fs.readFileSync(path.join(root, 'nodes', 'StreamerLog', 'sqlQuery.sql'), 'utf8'), /'streamerLog' AS evidenceType/);
  assert.match(fs.readFileSync(path.join(root, 'nodes', 'StreamerEventLog', 'sqlQuery.sql'), 'utf8'), /'streamEventLog' AS evidenceType/);
});
test('post-update rereads use the direct persisted requestKey', () => {
  for (const name of ['Re-read Reconciled Request', 'Re-read Frozen Request', 'Re-read Inference Request', 'Re-read Upload Request', 'Re-read Message Request', 'Re-read Failure Request', 'Re-read Completion Request']) {
    const expression = node(name).parameters.filters.conditions[0].keyValue;
    assert.equal(expression, '={{ $json.requestKey }}', name);
  }
});
test('reconciliation and freeze execute top-level mutations with updatedAtIso CAS', () => {
  for (const name of ['Reconcile Canonical Exact', 'Freeze Competing Canonicals']) {
    const item = node(name);
    const filters = Object.fromEntries(item.parameters.filters.conditions.map(({ keyName, keyValue }) => [keyName, keyValue]));
    assert.equal(filters.updatedAtIso, '={{ $json.expectedUpdatedAtIso }}', name);
    assert.equal('updatedAt' in filters, false, name);
    assert.match(JSON.stringify(item.parameters.columns.value), /\$json\.values\./, name);
  }
  assert.equal(source.match(/"Route Next Stage":\{"main"/g).length, 1);
  assert.deepEqual(node('Merge Reconciliation Plan And Reread').parameters, { mode: 'append', numberInputs: 2 });
  assert.deepEqual(node('Merge Freeze Plan And Reread').parameters, { mode: 'append', numberInputs: 2 });
  assert.equal(workflow.connections['Route Next Stage'].main[0].some(({ node: target, index }) => target === 'Merge Reconciliation Plan And Reread' && index === 0), true);
  assert.equal(workflow.connections['Route Next Stage'].main[1].some(({ node: target, index }) => target === 'Merge Freeze Plan And Reread' && index === 0), true);
  assert.equal(workflow.connections['Re-read Reconciled Request'].main[0][0].node, 'Merge Reconciliation Plan And Reread');
  assert.equal(workflow.connections['Re-read Frozen Request'].main[0][0].node, 'Merge Freeze Plan And Reread');
  const freezeValues = node('Freeze Competing Canonicals').parameters.columns.value;
  assert.equal(freezeValues.manualReviewAtIso, '={{ $json.values.manualReviewAtIso }}');
  assert.equal(freezeValues.manualReviewOriginalStage, '={{ $json.values.manualReviewOriginalStage }}');
});
test('failure CAS writes the complete attempt-aware failure plan', () => {
  const values = node('Failure CAS Exact').parameters.columns.value;
  assert.deepEqual(Object.keys(values).sort(), ['errorCode', 'leaseOwner', 'leaseUntilIso', 'nextRetryAtIso', 'status', 'summaryAttempt', 'updatedAtIso'].sort());
  for (const key of ['errorCode', 'leaseOwner', 'leaseUntilIso', 'nextRetryAtIso', 'status', 'summaryAttempt']) assert.equal(values[key], `={{ $json.values.${key} }}`);
});
test('connections contain no duplicate source keys and every node is reachable', () => {
  const connectionSource = source.slice(source.indexOf('"connections"'), source.indexOf('"settings"'));
  const keys = [...connectionSource.matchAll(/"([^"]+)":\{"main":/g)].map((match) => match[1]);
  assert.equal(new Set(keys).size, keys.length);
  const visited = new Set(['Start']);
  const queue = ['Start'];
  while (queue.length) {
    const current = queue.shift();
    for (const outputs of Object.values(workflow.connections[current] || {})) {
      for (const edge of outputs.flat()) if (!visited.has(edge.node)) { visited.add(edge.node); queue.push(edge.node); }
    }
  }
  assert.deepEqual(workflow.nodes.map(({ name }) => name).filter((name) => !visited.has(name)), []);
});
test('every persisted write plan carries a top-level requestKey for zero-CAS rereads', () => {
  const { planWrite } = require('../nodes/Plan_Write.js');
  const { planFailure } = require('../nodes/Plan_Failure.js');
  const carrier = { kind: 'carrier', input: input(), row: row(), ownerConditions: helper.ownerConditions(row()), nextStage: 'upload', checkpointValue: 'F08ABC123' };
  assert.equal(planWrite([carrier, row()]).requestKey, input().requestKey);
  const failure = { kind: 'failure_carrier', input: input(), row: row(), ownerConditions: helper.ownerConditions(row()), failureStage: 'upload', errorCode: 'upload_failed' };
  assert.equal(planFailure([failure, row()], NOW).requestKey, input().requestKey);
  const nextStageSource = fs.readFileSync(path.join(root, 'nodes', 'Plan_Next_Stage', 'jsCode.js'), 'utf8');
  assert.match(nextStageSource, /requestKey: input\.input\.requestKey/);
});
