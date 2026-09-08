const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const workflowDir = path.resolve(__dirname, '..');
const queryLogsWorkflowDir = path.resolve(
  workflowDir,
  '..',
  'query_steam_logs_v3_QueryLogsV3A0001',
);
const summaryOrchestratorWorkflowDir = path.resolve(
  workflowDir,
  '..',
  'summary_orchestrate_request_v3_SummaryOrchV3A01',
);
const { buildWorkflow } = require('../../../scripts/utils');
const {
  deduplicateCandidates,
  planCandidateReconciliation,
} = require('../nodes/Code_dedup/jsCode');
const {
  buildResolverCalls,
  chunkIDs,
} = require('../nodes/Chunk_Resolver_Input/jsCode');
const {
  buildReassembledRequests,
  eligibilityError,
  reassembleContexts,
} = require('../nodes/Reassemble_Resolver_Output/jsCode');
const { buildOrchestratorRequests } = require('../nodes/Build_Orchestrator_Requests/jsCode');
const {
  buildRootCheckpointPlans,
  planRootOwnership,
  verifyRootCheckpoint,
  verifyRootClaim,
} = require('../nodes/Plan_Candidate_Root/jsCode');
const { buildCandidateLogRequests } = require('../nodes/Build_Candidate_Log_Requests/jsCode');
const { buildLogCollectingStatuses } = require('../nodes/Build_Log_Collecting_Statuses/jsCode');
const { captureLogCollectingStatusCheckpoint } = require('../nodes/Capture_Log_Collecting_Status_Checkpoint/jsCode');
const { buildLogStatusUpdates } = require('../nodes/Build_Log_Status_Updates/jsCode');
const { summarizeQueryLogResults } = require('../nodes/Summarize_Query_Log_Results/jsCode');

const SQL_FILES = [
  'Comment_and_Caption_with_keywords1',
  'End_by_new_stream',
  'Caption_with_keywords',
  'Comment_and_Caption_with_keywords',
];

function readWorkflow() {
  return JSON.parse(fs.readFileSync(path.join(workflowDir, 'workflow.json'), 'utf8'));
}

function readQueryLogsWorkflow() {
  return JSON.parse(fs.readFileSync(path.join(queryLogsWorkflowDir, 'workflow.json'), 'utf8'));
}

function nodeByName(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `Missing node: ${name}`);
  return node;
}

function externalValue(value) {
  const prefix = '__EXTERNAL_FILE__://';
  return typeof value === 'string' && value.startsWith(prefix)
    ? fs.readFileSync(path.join(workflowDir, value.slice(prefix.length)), 'utf8')
    : value;
}

function runCheckpointRuntime(inputs, carriersByInputIndex) {
  const matchedIndexes = [];
  const source = fs.readFileSync(
    path.join(workflowDir, 'nodes', 'Capture_Log_Collecting_Status_Checkpoint', 'jsCode.js'),
    'utf8',
  );
  const context = {
    module: { exports: {} },
    $input: { all: () => inputs },
    $: (nodeName) => {
      assert.equal(nodeName, 'Build Log Collecting Status');
      return {
        itemMatching: (index) => {
          matchedIndexes.push(index);
          return { json: carriersByInputIndex[index] };
        },
      };
    },
  };
  const output = vm.runInNewContext(`(function () {\n${source}\n})()`, context, { filename: 'Capture_Log_Collecting_Status_Checkpoint/jsCode.js' });
  return { output, matchedIndexes };
}

function runAssembledCodeNode(workflowDir, name, inputs, namedNodes = {}) {
  const workflow = buildWorkflow(workflowDir);
  const source = nodeByName(workflow, name).parameters.jsCode;
  const context = {
    module: { exports: {} },
    $input: { all: () => inputs, first: () => inputs[0] },
    $: (nodeName) => {
      const items = namedNodes[nodeName];
      if (!items) throw new Error(`Unexpected node lookup: ${nodeName}`);
      return { all: () => items };
    },
  };
  return vm.runInNewContext(`(function () {\n${source}\n})()`, context, { filename: `${name}/jsCode.js` });
}

function collectorRequest(candidateIndex, streamIndex, eligible = true) {
  const candidateKey = `candidate-${candidateIndex}`;
  const summaryRequestKey = `summary-${candidateIndex}`;
  const threadTS = `178883310${candidateIndex}.000001`;
  const liveStreamID = String(9000 + candidateIndex * 10 + streamIndex);
  const streamContext = context(liveStreamID, streamIndex, { eligible });
  return {
    candidate: {
      candidateKey,
      summaryRequestKey,
      channel: 'C09F0SYG57D',
      threadTS,
    },
    stream: {
      role: streamIndex === 0 ? 'previous' : 'current',
      liveStreamID,
      mode: streamIndex === 0 ? 'fromEnd' : 'fromStart',
      durationMinutes: 5,
      streamContext,
      ...(eligible ? {} : { sttEligible: false }),
    },
  };
}

function logStatusCheckpoint(request) {
  return {
    carrier: {
      candidateKey: request.candidate.candidateKey,
      channel: request.candidate.channel,
      threadTS: request.candidate.threadTS,
    },
    checkpoint: {
      channel: request.candidate.channel,
      messageTimestamp: `${request.candidate.threadTS.slice(0, -6)}000099`,
    },
  };
}

function context(liveStreamID, inputIndex, overrides = {}) {
  return {
    inputIndex,
    status: 'found',
    source: 'livestream_v2',
    profile: 'stt',
    liveStreamID,
    userID: `user-${liveStreamID}`,
    openID: `open-${liveStreamID}`,
    beginTime: 1787360400,
    endTime: 1787364000,
    duration: 3600,
    region: 'TW',
    vliverModel: 1,
    eligible: true,
    ...overrides,
  };
}

test('uses the same parameterized one-day candidate bounds in all four SQL files', () => {
  for (const directory of SQL_FILES) {
    const sql = fs.readFileSync(path.join(workflowDir, 'nodes', directory, 'sqlQuery.sql'), 'utf8');
    assert.match(sql, /DECLARE queryEndDate TIMESTAMP DEFAULT TIMESTAMP\(@query_end\)/);
    assert.match(sql, /DECLARE queryStartDate TIMESTAMP DEFAULT TIMESTAMP_SUB\(queryEndDate, INTERVAL 1 DAY\)/);
    assert.match(sql, /TIMESTAMP_SECONDS\(beginTime\) >= queryStartDate/);
    assert.match(sql, /TIMESTAMP_SECONDS\(beginTime\) < queryEndDate/);
    assert.doesNotMatch(sql, /CURRENT_TIMESTAMP\(\).*INTERVAL 30 DAY|manualInterval|Manually trigger/s);
  }
});

test('chunks 0, 1, 100, 101, and 250 unique IDs at 100 without losing order', () => {
  for (const size of [0, 1, 100, 101, 250]) {
    const ids = Array.from({ length: size }, (_, index) => String(index + 1));
    const chunks = chunkIDs(ids);
    assert.ok(chunks.every((chunk) => chunk.length <= 100));
    assert.deepEqual(chunks.flat(), ids);
  }
  assert.deepEqual(chunkIDs(['7', '8', '7']), [['7', '8']]);
});

test('builds STT resolver calls and reassembles duplicate and missing positions', () => {
  const lookupWindow = { start: '2025-01-02T04:00:00+08:00', end: '2025-01-03T04:00:00+08:00' };
  const positions = [
    { originalIndex: 0, liveStreamID: '7' },
    { originalIndex: 1, liveStreamID: '8' },
    { originalIndex: 2, liveStreamID: '7' },
    { originalIndex: 3, liveStreamID: '9' },
  ];
  const calls = buildResolverCalls({ positions, lookupWindow });
  assert.deepEqual(calls.map(({ profile }) => profile), ['stt']);
  assert.deepEqual(calls[0].streams, [
    { liveStreamID: '7' },
    { liveStreamID: '8' },
    { liveStreamID: '9' },
  ]);
  const rows = [context('7', 0), context('8', 1)];
  const output = reassembleContexts({ positions, resolverCalls: calls }, rows);
  assert.deepEqual(output.map(({ liveStreamID }) => liveStreamID), ['7', '8', '7', '9']);
  assert.deepEqual(output.map(({ status }) => status), ['found', 'found', 'found', 'not_found']);
  assert.equal(output[2].originalIndex, 2);
  assert.equal(output[3].eligible, false);
});

test('returns an eligibility error for a bad candidate stream without throwing', () => {
  assert.equal(eligibilityError(context('7', 0)), null);
  assert.match(eligibilityError(context('8', 1, { eligible: false })), /Stream 8 is not eligible/);
  assert.match(eligibilityError({ liveStreamID: '9', status: 'not_found', eligible: false }), /Stream 9 is not eligible/);
});

test('marks only the ineligible stream and preserves other candidate streams', () => {
  const calls = [
    {
      candidate: { candidateKey: 'candidate-good' },
      positions: [{ originalIndex: 0, role: 'current', liveStreamID: '7', mode: 'fromStart' }],
    },
    {
      candidate: { candidateKey: 'candidate-bad' },
      positions: [{ originalIndex: 0, role: 'current', liveStreamID: '8', mode: 'fromStart' }],
    },
  ];
  const output = buildReassembledRequests(calls, [
    context('7', 0),
    context('8', 0, { eligible: false }),
  ]);

  assert.equal(output.length, 2);
  assert.equal(output[0].stream.liveStreamID, '7');
  assert.equal(output[1].candidate.candidateKey, 'candidate-bad');
  assert.match(output[1].eligibilityError, /Stream 8 is not eligible/);
  assert.equal(output[1].stream.liveStreamID, '8');
  assert.equal(output[1].stream.sttEligible, false);
});

test('builds partial paired requests when previous or current STT is unavailable', () => {
  const candidate = {
    candidateKey: 'candidate-pair',
    summaryRequestKey: 'summary-pair',
    channel: 'C0A4JJJKJMD',
    threadTS: '1787364000.000001',
  };
  const calls = [{
    candidate,
    positions: [
      { originalIndex: 0, role: 'previous', liveStreamID: '7', mode: 'fromEnd' },
      { originalIndex: 1, role: 'current', liveStreamID: '8', mode: 'fromStart' },
    ],
  }];

  for (const unavailableID of ['7', '8']) {
    const reassembled = buildReassembledRequests(calls, [
      context('7', 0, unavailableID === '7' ? { eligible: false, missingFields: ['openID'] } : {}),
      context('8', 1, unavailableID === '8' ? { eligible: false, missingFields: ['duration'] } : {}),
    ]);
    const eligible = reassembled.filter(({ eligibilityError: error }) => !error);
    const unavailable = reassembled.filter(({ eligibilityError: error }) => error);
    assert.equal(eligible.length, 1);
    assert.equal(unavailable.length, 1);
    assert.equal(unavailable[0].stream.liveStreamID, unavailableID);
    assert.match(unavailable[0].eligibilityError, /missingFields=/);

    const requests = buildOrchestratorRequests(reassembled, [{ message_timestamp: '1787364001.000002' }], [logStatusCheckpoint(reassembled[0])]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].orderedStreams.length, 2);
    assert.deepEqual(requests[0].orderedStreams.map(({ liveStreamID }) => liveStreamID), ['7', '8']);
    const unavailableStream = requests[0].orderedStreams.find(({ liveStreamID }) => liveStreamID === unavailableID);
    const eligibleStream = requests[0].orderedStreams.find(({ liveStreamID }) => liveStreamID !== unavailableID);
    assert.equal(unavailableStream.sttEligible, false);
    assert.equal(Object.hasOwn(unavailableStream, 'processingMessageTS'), false);
    assert.equal(eligibleStream.processingMessageTS, '1787364001.000002');
  }
});

test('emits per-stream warnings and no orchestrator request when both streams are ineligible', () => {
  const candidate = { candidateKey: 'candidate-bad-pair', summaryRequestKey: 'summary-bad-pair', threadTS: '1787364000.000001' };
  const calls = [{
    candidate,
    positions: [
      { originalIndex: 0, role: 'previous', liveStreamID: '7', mode: 'fromEnd' },
      { originalIndex: 1, role: 'current', liveStreamID: '8', mode: 'fromStart' },
    ],
  }];
  const reassembled = buildReassembledRequests(calls, [
    context('7', 0, { eligible: false, missingFields: ['openID'] }),
    context('8', 1, { eligible: false, missingFields: ['duration'] }),
  ]);

  assert.equal(reassembled.length, 2);
  assert.ok(reassembled.every(({ eligibilityError: error, stream: value }) => error && value.sttEligible === false));
  assert.deepEqual(buildOrchestratorRequests(reassembled, []), []);
});

test('builds checkpointed orchestrator requests in the assembled runtime and normalizes them downstream', () => {
  const requests = Array.from({ length: 10 }, (_, candidateIndex) => [
    collectorRequest(candidateIndex, 0),
    collectorRequest(candidateIndex, 1),
  ]).flat();
  const processingRows = requests.map((_, index) => ({
    message_timestamp: `178883320${String(index).padStart(2, '0')}.000001`,
  }));
  const checkpoints = requests.filter((_, index) => index % 2 === 0).map(logStatusCheckpoint).reverse();
  const output = runAssembledCodeNode(workflowDir, 'Build Orchestrator Requests', checkpoints.map((json) => ({ json })), {
    'Reassemble Resolver Output': requests.map((json) => ({ json })),
    'Send Processing Message': processingRows.map((json) => ({ json })),
  });

  const collectorWorkflow = buildWorkflow(workflowDir);
  const summaryWorkflow = buildWorkflow(summaryOrchestratorWorkflowDir);
  assert.deepEqual(collectorWorkflow.connections['Capture Log Collecting Status Checkpoint'].main[0][0], {
    node: 'Build Orchestrator Requests', type: 'main', index: 0,
  });
  assert.deepEqual(collectorWorkflow.connections['Build Orchestrator Requests'].main[0], [{
    node: 'Call Summary Orchestrator', type: 'main', index: 0,
  }]);
  assert.deepEqual(summaryWorkflow.connections.Start.main[0], [{
    node: 'Normalize Request', type: 'main', index: 0,
  }]);
  assert.equal(output.length, 10);
  for (const [index, item] of output.entries()) {
    assert.equal(item.json.requestKey, `summary-${index}`);
    assert.equal(runAssembledCodeNode(summaryOrchestratorWorkflowDir, 'Normalize Request', [item]).length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(item.json.orderedStreams.map(({ processingMessageTS }) => processingMessageTS))), [
      processingRows[index * 2].message_timestamp,
      processingRows[index * 2 + 1].message_timestamp,
    ]);
    assert.notEqual(item.json.orderedStreams[0].processingMessageTS, checkpoints[0].checkpoint.messageTimestamp);
  }

  const partial = requests.map((request) => ({ ...request, stream: { ...request.stream } }));
  for (const [index, request] of partial.entries()) {
    if (index % 2 === 1) {
      request.stream.sttEligible = false;
      request.stream.streamContext.eligible = false;
    }
  }
  const partialCheckpoints = partial.filter((_, index) => index % 2 === 0).map(logStatusCheckpoint);
  assert.equal(buildOrchestratorRequests(partial, processingRows.filter((_, index) => index % 2 === 0), partialCheckpoints).length, 10);

  const noneEligible = partial.map((request) => ({ ...request, stream: { ...request.stream, sttEligible: false, streamContext: { ...request.stream.streamContext, eligible: false } } }));
  assert.deepEqual(buildOrchestratorRequests(noneEligible, [], []), []);
  assert.throws(() => buildOrchestratorRequests(requests, processingRows, checkpoints.slice(1)), /does not match/);
  assert.throws(() => buildOrchestratorRequests(requests, processingRows, [checkpoints[0], checkpoints[0], ...checkpoints.slice(1)]), /Duplicate/);
  assert.throws(() => buildOrchestratorRequests(requests, processingRows, [{
    ...checkpoints[0], carrier: { ...checkpoints[0].carrier, channel: 'C0A4JJJKJMD' },
  }, ...checkpoints.slice(1)]), /invalid/);
  assert.throws(() => buildOrchestratorRequests(requests, processingRows, [{
    ...checkpoints[0], carrier: { ...checkpoints[0].carrier, threadTS: '1788833999.000001' },
  }, ...checkpoints.slice(1)]), /does not match/);
  assert.throws(() => buildOrchestratorRequests(requests, processingRows, [{
    ...checkpoints[0], carrier: { ...checkpoints[0].carrier, candidateKey: 'wrong-candidate' },
  }, ...checkpoints.slice(1)]), /does not match/);
  assert.throws(() => runAssembledCodeNode(workflowDir, 'Build Orchestrator Requests', [{ json: { message_timestamp: '1788833999.000001' } }]), /requires log collecting status checkpoints/);
});

test('deduplicates provenance and preserves an existing candidate canonical', () => {
  const candidates = deduplicateCandidates([
    { streamID: '9002', prevStreamID: '9001', userID: 'u1', metricSource: 'captionKeyword' },
    { streamID: '9002', prevStreamID: '9001', userID: 'u1', metricSource: 'endByNewStream' },
  ], { runID: 'run-1', nowIso: '2026-08-22T00:00:00.000Z' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateKey, 'suspect:run-1:9001:9002');
  assert.equal(candidates[0].summaryRequestKey, 'suspect-summary:suspect:run-1:9001:9002');
  assert.deepEqual(JSON.parse(candidates[0].sourcesJson), ['captionKeyword', 'endByNewStream']);
  assert.equal(candidates[0].channel, 'C0A4JJJKJMD');
  assert.equal(candidates[0].reconciliationStatus, 'pending');
  assert.equal(candidates[0].canonicalRowID, '');

  const rows = [
    { ...candidates[0], id: 2, createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: '2' },
    { ...candidates[0], id: 1, createdAt: '2026-08-22T00:01:00.000Z', reconciliationStatus: 'pending', canonicalRowID: '' },
  ];
  const plan = planCandidateReconciliation(rows);
  assert.equal(plan.canonical.id, 2);
  assert.equal(plan.mutations[0].desiredReconciliationStatus, 'duplicate');
  assert.equal(plan.mutations[0].desiredCanonicalRowID, '2');
});

test('routes candidates to either allowlisted channel', () => {
  for (const channel of ['C0A4JJJKJMD', 'C09F0SYG57D']) {
    const candidates = deduplicateCandidates([
      { streamID: '9002', metricSource: 'captionKeyword' },
    ], {
      runID: 'run-production',
      nowIso: '2026-08-22T00:00:00.000Z',
      channel,
    });
    assert.equal(candidates[0].channel, channel);
  }
  assert.throws(() => deduplicateCandidates([], {
    runID: 'run-invalid',
    nowIso: '2026-08-22T00:00:00.000Z',
    channel: 'C0OTHER',
  }), /allowed channel/);
});

test('routes every collector Slack send through the shared run channel', () => {
  const workflow = readWorkflow();
  const sharedChannel = "={{ $('Build Candidate Query Config').first().json.channel }}";
  const runChannels = Object.fromEntries([
    'Configure Manual Run',
    'Configure Scheduled Run',
  ].map((name) => [
    name,
    nodeByName(workflow, name).parameters.assignments.assignments.find(({ name: field }) => field === 'channel').value,
  ]));

  assert.deepEqual(runChannels, {
    'Configure Manual Run': 'C09F0SYG57D',
    'Configure Scheduled Run': 'C09F0SYG57D',
  });
  assert.equal(nodeByName(workflow, 'Build Candidate Query Config').parameters.includeOtherFields, true);
  for (const name of [
    'Send Monitoring Report',
    'Send Candidate Detail',
    'Send Candidate Eligibility Warning',
    'Send Processing Message',
  ]) {
    assert.equal(nodeByName(workflow, name).parameters.channelId.value, sharedChannel, name);
  }
});

test('creates fresh candidate and request identities for every collector execution', () => {
  const rows = [
    { streamID: '9002', prevStreamID: '9001', userID: 'u1', metricSource: 'captionKeyword' },
  ];
  const first = deduplicateCandidates(rows, {
    runID: 'execution-1',
    nowIso: '2026-08-22T00:00:00.000Z',
  })[0];
  const second = deduplicateCandidates(rows, {
    runID: 'execution-2',
    nowIso: '2026-08-22T00:01:00.000Z',
  })[0];

  assert.notEqual(first.candidateKey, second.candidateKey);
  assert.notEqual(first.summaryRequestKey, second.summaryRequestKey);
  assert.equal(first.threadTS, '');
  assert.equal(second.threadTS, '');
});

test('chooses system earliest candidate only when no canonical exists', () => {
  const rows = [
    { id: 2, candidateKey: 'candidate-1', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'pending', canonicalRowID: '' },
    { id: 1, candidateKey: 'candidate-1', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'pending', canonicalRowID: '' },
  ];
  assert.equal(planCandidateReconciliation(rows).canonical.id, 1);
});

test('requires numeric production system IDs and string canonical references at every Data Table boundary', () => {
  const rows = [
    { id: 2, candidateKey: 'candidate-1', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'pending', canonicalRowID: '' },
    { id: 1, candidateKey: 'candidate-1', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'pending', canonicalRowID: '' },
  ];
  const plan = planCandidateReconciliation(rows);
  assert.deepEqual(plan.mutations.map(({ id, desiredCanonicalRowID }) => [id, desiredCanonicalRowID]), [[2, '1'], [1, '1']]);
  assert.throws(() => planCandidateReconciliation([{ ...rows[0], id: '2' }]), /invalid candidate reconciliation row/);

  const workflow = readWorkflow();
  for (const table of workflow.nodes.filter(({ type, parameters }) => (
    type === 'n8n-nodes-base.dataTable' && parameters.filters?.conditions
  ))) {
    for (const condition of table.parameters.filters.conditions) {
      if (condition.keyName === 'id') assert.doesNotMatch(condition.keyValue, /String\(/, table.name);
      if (condition.keyName === 'canonicalRowID') assert.match(condition.keyValue, /String\(/, table.name);
    }
  }
});

test('claims candidate root before Slack and rejects a losing or zero-CAS owner', () => {
  const row = {
    id: 1, candidateKey: 'candidate-1', createdAt: '2026-08-22T00:00:00.000Z',
    reconciliationStatus: 'canonical', canonicalRowID: '1', threadTS: '',
  };
  const first = planRootOwnership(row, 'execution-1', '2026-08-22T00:00:00.000Z');
  const second = planRootOwnership(row, 'execution-2', '2026-08-22T00:00:00.000Z');
  assert.equal(first.action, 'claim');
  assert.notEqual(first.desiredThreadTS, second.desiredThreadTS);
  const persisted = [{ ...row, threadTS: first.desiredThreadTS }];
  assert.equal(verifyRootClaim(first, persisted).rootClaimVerified, true);
  assert.throws(() => verifyRootClaim(second, persisted), /claim CAS was not persisted/);
  assert.equal(planRootOwnership(persisted[0], 'execution-3', '2026-08-22T00:01:00.000Z').action, 'blocked');
});

test('requires a valid exact Slack root checkpoint before resolver eligibility', () => {
  const row = {
    id: 1, candidateKey: 'candidate-1', createdAt: '2026-08-22T00:00:00.000Z',
    reconciliationStatus: 'canonical', canonicalRowID: '1', threadTS: '',
  };
  const claim = planRootOwnership(row, 'execution-1', '2026-08-22T00:00:00.000Z');
  const owner = verifyRootClaim(claim, [{ ...row, threadTS: claim.desiredThreadTS }]);
  assert.throws(() => buildRootCheckpointPlans([owner], [{ message: { ts: '' } }]), /timestamp is invalid/);
  const checkpoint = buildRootCheckpointPlans([owner], [{ message: { ts: '1787364000.000001' } }])[0];
  assert.throws(() => verifyRootCheckpoint(checkpoint, [{ ...row, threadTS: claim.desiredThreadTS }]), /checkpoint CAS was not persisted/);
  assert.equal(verifyRootCheckpoint(checkpoint, [{ ...row, threadTS: checkpoint.desiredThreadTS }]).action, 'ready');
});

test('builds previous then current Query Logs requests only for checkpointed canonical candidates', () => {
  const candidate = {
    id: 1,
    action: 'ready',
    reconciliationStatus: 'canonical',
    canonicalRowID: '1',
    channel: 'C0A4JJJKJMD',
    threadTS: '1787364000.000001',
    prevStreamID: '9001',
    streamID: '9002',
  };
  assert.deepEqual(buildCandidateLogRequests([candidate]), [
    { streamID: '9001', channel: 'C0A4JJJKJMD', target_thread_ts: '1787364000.000001' },
    { streamID: '9002', channel: 'C0A4JJJKJMD', target_thread_ts: '1787364000.000001' },
  ]);
  assert.deepEqual(buildCandidateLogRequests([{ ...candidate, prevStreamID: '' }]), [
    { streamID: '9002', channel: 'C0A4JJJKJMD', target_thread_ts: '1787364000.000001' },
  ]);
  assert.deepEqual(buildCandidateLogRequests([{ ...candidate, channel: 'C09F0SYG57D' }]), [
    { streamID: '9001', channel: 'C09F0SYG57D', target_thread_ts: '1787364000.000001' },
    { streamID: '9002', channel: 'C09F0SYG57D', target_thread_ts: '1787364000.000001' },
  ]);
  assert.throws(() => buildCandidateLogRequests([{ ...candidate, channel: 'C0OTHER' }]), /channel is not allowed/);
  assert.throws(() => buildCandidateLogRequests([{ ...candidate, threadTS: '1787364000.1' }]), /timestamp is invalid/);
  assert.throws(() => buildCandidateLogRequests([{ ...candidate, streamID: 'stream-9002' }]), /numeric stream ID/);
  assert.throws(() => buildCandidateLogRequests([{ ...candidate, action: 'owned' }]), /checkpointed canonical/);
});

test('summarizes best-effort Query Logs failures and detects missing or duplicated results', () => {
  const expected = [
    { streamID: '9001', target_thread_ts: '1787364000.000001' },
    { streamID: '9002', target_thread_ts: '1787364000.000001' },
  ];
  const successful = expected.map((request) => ({ ...request, ok: true }));
  assert.deepEqual(summarizeQueryLogResults(successful, expected), {
    expectedCount: 2,
    resultCount: 2,
    successCount: 2,
    failureCount: 0,
    missingKeys: [],
    unexpectedKeys: [],
    failures: [],
    allSucceeded: true,
    errorMessage: '',
  });

  const failed = summarizeQueryLogResults([
    { ...expected[0], ok: false, failedNode: 'Upload StreamLog1', errorMessage: 'connection timed out' },
  ], expected);
  assert.equal(failed.allSucceeded, false);
  assert.equal(failed.failureCount, 1);
  assert.deepEqual(failed.missingKeys, ['1787364000.000001:9002']);
  assert.match(failed.errorMessage, /1 child error\(s\), 1 missing result\(s\)/);

  const completedWithFailure = summarizeQueryLogResults([
    successful[0],
    { ...expected[1], ok: false, failedNode: 'Get Slack Upload URL', errorMessage: 'connection timed out' },
  ], expected);
  assert.equal(completedWithFailure.resultCount, 2);
  assert.equal(completedWithFailure.successCount, 1);
  assert.equal(completedWithFailure.failureCount, 1);
  assert.deepEqual(completedWithFailure.missingKeys, []);
  assert.deepEqual(completedWithFailure.unexpectedKeys, []);
  assert.equal(completedWithFailure.allSucceeded, false);

  const duplicated = summarizeQueryLogResults([successful[0], successful[0]], expected);
  assert.equal(duplicated.allSucceeded, false);
  assert.deepEqual(duplicated.missingKeys, ['1787364000.000001:9002']);
  assert.deepEqual(duplicated.unexpectedKeys, ['1787364000.000001:9001']);
});

test('posts one collecting status per eligible candidate after all of its STT statuses', () => {
  const candidateA = { candidateKey: 'candidate-a', channel: 'C0A4JJJKJMD', threadTS: '1787364000.000001' };
  const candidateB = { candidateKey: 'candidate-b', channel: 'C09F0SYG57D', threadTS: '1787364000.000002' };
  const statuses = buildLogCollectingStatuses([
    { candidate: candidateA, stream: { liveStreamID: '9001' } },
    { candidate: candidateA, stream: { liveStreamID: '9002' } },
    { candidate: candidateB, stream: { liveStreamID: '9003', sttEligible: false } },
  ], [
    { ok: true, channel: 'C0A4JJJKJMD', message: {}, message_timestamp: '1787364001.000001' },
    { ok: true, channel: 'C0A4JJJKJMD', message: {}, message_timestamp: '1787364001.000002' },
  ]);
  assert.deepEqual(statuses.map(({ candidateKey, threadTS, streamIDs }) => ({ candidateKey, threadTS, streamIDs })), [{
    candidateKey: 'candidate-a', threadTS: '1787364000.000001', streamIDs: ['9001', '9002'],
  }]);
  assert.match(statuses[0].logStatusText, /9001/);
  assert.throws(() => buildLogCollectingStatuses([{ candidate: candidateA, stream: { liveStreamID: '9001' } }], [{ message_timestamp: 1787364001.000001 }]), /timestamp is invalid/);
});

test('checkpoints actual Slack status responses without inferred thread metadata', () => {
  const carrierA = { candidateKey: 'candidate-a', channel: 'C0A4JJJKJMD', threadTS: '1788833100.000001' };
  const carrierB = { candidateKey: 'candidate-b', channel: 'C09F0SYG57D', threadTS: '1788833100.000002' };
  const actualResponse = { ok: true, channel: 'C09F0SYG57D', message: { ts: '1788833179.331339' }, message_timestamp: '1788833179.331339' };
  const checkpoint = captureLogCollectingStatusCheckpoint(actualResponse, carrierB);

  assert.deepEqual(checkpoint, {
    carrier: carrierB,
    checkpoint: { channel: 'C09F0SYG57D', messageTimestamp: '1788833179.331339' },
  });
  assert.throws(() => captureLogCollectingStatusCheckpoint({ ...actualResponse, channel: 'C0A4JJJKJMD' }, carrierB), /response is invalid/);
  assert.throws(() => captureLogCollectingStatusCheckpoint({ ...actualResponse, message_timestamp: 'invalid' }, carrierB), /response is invalid/);
  assert.throws(() => captureLogCollectingStatusCheckpoint({ ...actualResponse, message: { thread_ts: carrierA.threadTS } }, carrierB), /thread does not match/);
});

test('uses itemMatching linkage for reordered Slack responses and emits input linkage', () => {
  const responseA = { ok: true, channel: 'C0A4JJJKJMD', message: { ts: '1788833179.331340' }, message_timestamp: '1788833179.331340' };
  const responseB = { ok: true, channel: 'C09F0SYG57D', message: { ts: '1788833179.331339' }, message_timestamp: '1788833179.331339' };
  const carrierA = { candidateKey: 'candidate-a', channel: 'C0A4JJJKJMD', threadTS: '1788833100.000001' };
  const carrierB = { candidateKey: 'candidate-b', channel: 'C09F0SYG57D', threadTS: '1788833100.000002' };
  const { output, matchedIndexes } = runCheckpointRuntime([
    { json: responseB, pairedItem: [{ item: 99 }] },
    { json: responseA, pairedItem: { item: 42 } },
  ], [carrierB, carrierA]);

  assert.deepEqual(matchedIndexes, [0, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(output)), [
    { json: captureLogCollectingStatusCheckpoint(responseB, carrierB), pairedItem: { item: 0 } },
    { json: captureLogCollectingStatusCheckpoint(responseA, carrierA), pairedItem: { item: 1 } },
  ]);
});

test('updates only matching checkpointed log statuses without exposing child errors', () => {
  const results = [
    { streamID: '9001', target_thread_ts: '1787364000.000001', ok: true },
    { streamID: '9002', target_thread_ts: '1787364000.000002', ok: false, errorMessage: 'secret transport failure' },
    { streamID: 'ignored', target_thread_ts: '1787364000.000099', ok: false },
  ];
  const expected = [
    { streamID: '9001', target_thread_ts: '1787364000.000001' },
    { streamID: '9002', target_thread_ts: '1787364000.000002' },
  ];
  const carriers = [
    { candidateKey: 'candidate-a', channel: 'C0A4JJJKJMD', threadTS: '1787364000.000001' },
    { candidateKey: 'candidate-b', channel: 'C09F0SYG57D', threadTS: '1787364000.000002' },
  ];
  const checkpoints = [
    captureLogCollectingStatusCheckpoint({ ok: true, channel: 'C09F0SYG57D', message: { ts: '1787364001.000002' }, message_timestamp: '1787364001.000002' }, carriers[1]),
    captureLogCollectingStatusCheckpoint({ ok: true, channel: 'C0A4JJJKJMD', message: { ts: '1787364001.000001' }, message_timestamp: '1787364001.000001' }, carriers[0]),
  ];
  const updates = buildLogStatusUpdates(results, expected, carriers, checkpoints);
  assert.deepEqual(updates.map(({ channel, ts }) => ({ channel, ts })), [
    { channel: 'C0A4JJJKJMD', ts: '1787364001.000001' },
    { channel: 'C09F0SYG57D', ts: '1787364001.000002' },
  ]);
  assert.match(updates[0].text, /completed \(1\/1\)/);
  assert.match(updates[1].text, /with issues/);
  assert.doesNotMatch(updates[1].text, /secret transport failure/);
  assert.throws(() => buildLogStatusUpdates(results, expected, carriers, [checkpoints[0]]), /does not match/);
  assert.throws(() => buildLogStatusUpdates(results, expected, carriers, [checkpoints[0], checkpoints[0]]), /Duplicate/);
  assert.throws(() => buildLogStatusUpdates(results, expected, [carriers[0], carriers[0]], [checkpoints[1]]), /Duplicate log collecting status carrier/);
  const missingResultUpdates = buildLogStatusUpdates([results[0]], expected, carriers, checkpoints);
  assert.match(missingResultUpdates.find(({ channel }) => channel === 'C09F0SYG57D').text, /with issues \(0\/1 delivered\)/);
});

test('is active with manual test-channel and daily production-channel triggers', () => {
  const workflow = readWorkflow();
  assert.equal(workflow.active, true);
  const triggers = workflow.nodes.filter(({ type }) => /Trigger$/i.test(type));
  assert.deepEqual(triggers.map(({ type }) => type), ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.scheduleTrigger']);
  const config = nodeByName(workflow, 'Build Candidate Query Config');
  const queryEndExpression = config.parameters.assignments.assignments.find(({ name }) => name === 'queryEnd').value;
  assert.match(queryEndExpression, /targetDate must be YYYY-MM-DD/);
  assert.match(queryEndExpression, /DateTime\.fromISO\(`\$\{targetDate\}T04:00:00`, \{ zone: 'Asia\/Taipei' \}\)\.plus\(\{ days: 1 \}\)/);
  assert.deepEqual(nodeByName(workflow, 'Configure Manual Run').parameters.assignments.assignments.map(({ name, value, type }) => ({ name, value, type })), [
    { name: 'targetDate', value: '', type: 'string' },
    { name: 'channel', value: 'C09F0SYG57D', type: 'string' },
  ]);
  assert.deepEqual(nodeByName(workflow, 'Configure Scheduled Run').parameters.assignments.assignments.map(({ name, value, type }) => ({ name, value, type })), [
    { name: 'targetDate', value: '', type: 'string' },
    { name: 'channel', value: 'C09F0SYG57D', type: 'string' },
  ]);
  const schedule = nodeByName(workflow, 'Daily 10:00 Taipei Trigger');
  assert.equal(schedule.typeVersion, 1.4);
  assert.equal(schedule.parameters.rule.interval[0].triggerAtHour, 10);
  assert.equal(schedule.parameters.rule.interval[0].triggerAtMinute, 0);
  assert.equal(workflow.settings.timezone, 'Asia/Taipei');
  assert.ok(workflow.connections['Manually Trigger'].main[0].some(({ node }) => node === 'Configure Manual Run'));
  assert.ok(workflow.connections['Configure Manual Run'].main[0].some(({ node }) => node === 'Build Candidate Query Config'));
  assert.ok(workflow.connections['Daily 10:00 Taipei Trigger'].main[0].some(({ node }) => node === 'Configure Scheduled Run'));
  assert.ok(workflow.connections['Configure Scheduled Run'].main[0].some(({ node }) => node === 'Build Candidate Query Config'));
  assert.ok(workflow.nodes.every(({ type }) => type !== 'n8n-nodes-base.wait'));
  assert.equal(nodeByName(workflow, 'Resolve Stream Metadata').parameters.workflowId.value, 'StreamMetaV3A001');
  assert.equal(nodeByName(workflow, 'Resolve Stream Metadata').parameters.mode, 'each');
  assert.equal(nodeByName(workflow, 'Call Summary Orchestrator').parameters.workflowId.value, 'SummaryOrchV3A01');
  assert.equal(nodeByName(workflow, 'Call Summary Orchestrator').parameters.mode, 'each');
  const queryLogs = nodeByName(workflow, 'Call Query Steam Logs');
  assert.equal(queryLogs.parameters.workflowId.value, 'QueryLogsV3A0001');
  assert.equal(queryLogs.parameters.mode, 'once');
  assert.equal(queryLogs.parameters.options.waitForSubWorkflow, true);
  assert.equal(queryLogs.alwaysOutputData, undefined);
  assert.equal(queryLogs.onError, 'continueErrorOutput');
  assert.deepEqual(Object.keys(queryLogs.parameters.workflowInputs.value).sort(), ['channel', 'lookbackDays', 'streamID', 'target_thread_ts']);
  assert.equal(queryLogs.parameters.workflowInputs.value.lookbackDays, 3);
  assert.deepEqual(queryLogs.parameters.workflowInputs.schema.map(({ id, type, required }) => ({ id, type, required })), [
    { id: 'streamID', type: 'string', required: true },
    { id: 'channel', type: 'string', required: true },
    { id: 'target_thread_ts', type: 'string', required: true },
    { id: 'lookbackDays', type: 'number', required: false },
  ]);
  assert.equal(queryLogs.parameters.workflowInputs.convertFieldsToString, false);
  const queryLogsLoop = nodeByName(workflow, 'Query Logs Loop');
  assert.equal(queryLogsLoop.type, 'n8n-nodes-base.splitInBatches');
  assert.equal(queryLogsLoop.typeVersion, 3);
  assert.equal(queryLogsLoop.parameters.batchSize, 1);
  assert.deepEqual(queryLogsLoop.parameters.options, {});
  assert.equal(nodeByName(workflow, 'Limit Query Logs Loop Done').parameters.maxItems, 1);
  assert.equal(nodeByName(workflow, 'Build Candidate Log Requests').parameters.jsCode, '__EXTERNAL_FILE__://nodes/Build_Candidate_Log_Requests/jsCode.js');
  assert.deepEqual(workflow.connections['Verify Candidate Root Checkpoint'].main[0].map(({ node }) => node), [
    'Prepare Resolver Chunks', 'Build Candidate Log Requests',
  ]);
  assert.deepEqual(workflow.connections['Build Candidate Log Requests'].main[0].map(({ node }) => node), ['Query Logs Loop']);
  assert.deepEqual(workflow.connections['Query Logs Loop'].main, [
    [
      { node: 'Summarize Query Log Results', type: 'main', index: 0 },
      { node: 'Merge Log Status Update Inputs', type: 'main', index: 0 },
    ],
    [{ node: 'Call Query Steam Logs', type: 'main', index: 0 }],
  ]);
  assert.deepEqual(workflow.connections['Call Query Steam Logs'].main, [
    [{ node: 'Mark Query Logs Success', type: 'main', index: 0 }],
    [{ node: 'Mark Query Logs Failure', type: 'main', index: 0 }],
  ]);
  assert.match(externalValue(nodeByName(workflow, 'Mark Query Logs Failure').parameters.jsonOutput), /typeof error === 'string'/);
  assert.deepEqual(workflow.connections['Mark Query Logs Success'].main[0], [{ node: 'Query Logs Loop', type: 'main', index: 0 }]);
  assert.deepEqual(workflow.connections['Mark Query Logs Failure'].main[0], [{ node: 'Query Logs Loop', type: 'main', index: 0 }]);
  assert.equal(nodeByName(workflow, 'Summarize Query Log Results').parameters.jsCode, '__EXTERNAL_FILE__://nodes/Summarize_Query_Log_Results/jsCode.js');
  assert.deepEqual(workflow.connections['Summarize Query Log Results'].main[0], [{ node: 'All Query Logs Succeeded', type: 'main', index: 0 }]);
  assert.equal(nodeByName(workflow, 'Build Log Status Updates').parameters.jsCode, '__EXTERNAL_FILE__://nodes/Build_Log_Status_Updates/jsCode.js');
  assert.deepEqual(workflow.connections['Build Log Status Updates'].main[0], [{ node: 'Update Log Collecting Status', type: 'main', index: 0 }]);
  const logStatusMerge = nodeByName(workflow, 'Merge Log Status Update Inputs');
  assert.equal(logStatusMerge.parameters.mode, 'append');
  assert.deepEqual(workflow.connections['Query Logs Loop'].main[0], [
    { node: 'Summarize Query Log Results', type: 'main', index: 0 },
    { node: 'Merge Log Status Update Inputs', type: 'main', index: 0 },
  ]);
  assert.deepEqual(workflow.connections['Merge Log Status Update Inputs'].main[0], [{ node: 'Build Log Status Updates', type: 'main', index: 0 }]);
  assert.deepEqual(workflow.connections['All Query Logs Succeeded'].main, [
    [{ node: 'Limit Query Logs Loop Done', type: 'main', index: 0 }],
    [{ node: 'Limit Query Logs Loop Done', type: 'main', index: 0 }],
  ]);
  assert.equal(workflow.nodes.some(({ name }) => name === 'Fail Query Logs Delivery'), false);
  assert.match(workflow.description, /best-effort attachments/);
  assert.match(workflow.description, /posts STT then log-collecting statuses before asynchronously calling the Summary orchestrator/);
  const queryLogsWorkflow = readQueryLogsWorkflow();
  const slackNodes = queryLogsWorkflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.slack');
  assert.equal(slackNodes.length, 2);
  for (const node of slackNodes) {
    assert.notEqual(node.retryOnFail, true, node.name);
    assert.equal(node.maxTries, undefined, node.name);
    assert.equal(node.waitBetweenTries, undefined, node.name);
  }
  assert.match(externalValue(nodeByName(workflow, 'Send Monitoring Report').parameters.text), /自動化異常 Stream 監控報告/);
  assert.match(externalValue(nodeByName(workflow, 'Send Candidate Detail').parameters.text), /自動化檢測詳情/);
  assert.ok(!workflow.nodes.some(({ name }) => name === 'Send Candidate Root'));
  assert.deepEqual(workflow.connections['Deduplicate Candidate Provenance'].main[0].map(({ node }) => node), ['Build Monitoring Report']);
  assert.deepEqual(workflow.connections['Send Monitoring Report'].main[0].map(({ node }) => node), ['Restore Candidate Items']);
  assert.deepEqual(workflow.connections['Candidate Is Eligible'].main[1].map(({ node }) => node), ['Send Candidate Eligibility Warning']);
  assert.equal(nodeByName(workflow, 'Candidate Is Eligible').parameters.conditions.conditions[0].operator.operation, 'empty');
  assert.equal(nodeByName(workflow, 'Build Log Collecting Status').parameters.jsCode, '__EXTERNAL_FILE__://nodes/Build_Log_Collecting_Statuses/jsCode.js');
  assert.equal(nodeByName(workflow, 'Capture Log Collecting Status Checkpoint').parameters.jsCode, '__EXTERNAL_FILE__://nodes/Capture_Log_Collecting_Status_Checkpoint/jsCode.js');
  const sendLogStatus = nodeByName(workflow, 'Send Log Collecting Status');
  assert.deepEqual(sendLogStatus.credentials, nodeByName(workflow, 'Send Processing Message').credentials);
  assert.equal(sendLogStatus.retryOnFail, undefined);
  assert.deepEqual(Object.fromEntries(['resource', 'operation', 'messageType'].map((key) => [key, sendLogStatus.parameters[key]])), { resource: 'message', operation: 'post', messageType: 'text' });
  assert.equal(nodeByName(workflow, 'Update Log Collecting Status').parameters.operation, 'update');
  assert.equal(nodeByName(workflow, 'Update Log Collecting Status').parameters.resource, 'message');
  assert.equal(nodeByName(workflow, 'Update Log Collecting Status').parameters.messageType, 'text');
  assert.equal(nodeByName(workflow, 'Update Log Collecting Status').parameters.updateFields, undefined);
  assert.equal(nodeByName(workflow, 'Update Log Collecting Status').retryOnFail, undefined);
  assert.deepEqual(workflow.connections['Send Processing Message'].main[0], [{ node: 'Build Log Collecting Status', type: 'main', index: 0 }]);
  assert.deepEqual(workflow.connections['Build Log Collecting Status'].main[0], [{ node: 'Send Log Collecting Status', type: 'main', index: 0 }]);
  assert.deepEqual(workflow.connections['Send Log Collecting Status'].main[0], [{ node: 'Capture Log Collecting Status Checkpoint', type: 'main', index: 0 }]);
  assert.deepEqual(workflow.connections['Capture Log Collecting Status Checkpoint'].main[0], [
    { node: 'Build Orchestrator Requests', type: 'main', index: 0 },
    { node: 'Merge Log Status Update Inputs', type: 'main', index: 1 },
  ]);
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /Suspect stream summary request/);
  assert.doesNotMatch(serialized, /AISummaryV3A0001|sOSbXSfXFcMLeIfr/);
  for (const node of workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.dataTable')) {
    assert.deepEqual(node.parameters.dataTableId, { __rl: true, mode: 'name', value: 'suspect_stt_candidates_v3' });
  }
  assert.equal(nodeByName(workflow, 'Claim Candidate Root').parameters.matchType, 'allConditions');
  assert.equal(nodeByName(workflow, 'Checkpoint Candidate Root').parameters.matchType, 'allConditions');
  assert.doesNotThrow(() => buildWorkflow(workflowDir));
});
