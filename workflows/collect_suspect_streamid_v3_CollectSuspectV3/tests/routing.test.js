const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowDir = path.resolve(__dirname, '..');
const queryLogsWorkflowDir = path.resolve(
  workflowDir,
  '..',
  'query_steam_logs_v3_QueryLogsV3A0001',
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
const {
  buildRootCheckpointPlans,
  planRootOwnership,
  verifyRootCheckpoint,
  verifyRootClaim,
} = require('../nodes/Plan_Candidate_Root/jsCode');
const { buildCandidateLogRequests } = require('../nodes/Build_Candidate_Log_Requests/jsCode');
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

test('skips only the candidate with an ineligible stream and preserves other requests', () => {
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
  assert.throws(() => buildCandidateLogRequests([{ ...candidate, channel: 'C0OTHER' }]), /channel is not allowed/);
  assert.throws(() => buildCandidateLogRequests([{ ...candidate, threadTS: '1787364000.1' }]), /timestamp is invalid/);
  assert.throws(() => buildCandidateLogRequests([{ ...candidate, streamID: 'stream-9002' }]), /numeric stream ID/);
  assert.throws(() => buildCandidateLogRequests([{ ...candidate, action: 'owned' }]), /checkpointed canonical/);
});

test('summarizes Query Logs child failures and detects missing or duplicated results', () => {
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

  const duplicated = summarizeQueryLogResults([successful[0], successful[0]], expected);
  assert.equal(duplicated.allSucceeded, false);
  assert.deepEqual(duplicated.missingKeys, ['1787364000.000001:9002']);
  assert.deepEqual(duplicated.unexpectedKeys, ['1787364000.000001:9001']);
});

test('is inactive, manual-only, supports a configured date override, is C0-only, and routes resolver output only to the orchestrator', () => {
  const workflow = readWorkflow();
  assert.equal(workflow.active, false);
  const triggers = workflow.nodes.filter(({ type }) => /Trigger$/i.test(type));
  assert.deepEqual(triggers.map(({ type }) => type), ['n8n-nodes-base.manualTrigger']);
  const config = nodeByName(workflow, 'Build Candidate Query Config');
  const queryEndExpression = config.parameters.assignments.assignments.find(({ name }) => name === 'queryEnd').value;
  assert.match(queryEndExpression, /targetDate must be YYYY-MM-DD/);
  assert.match(queryEndExpression, /DateTime\.fromISO\(`\$\{targetDate\}T04:00:00`, \{ zone: 'Asia\/Taipei' \}\)\.plus\(\{ days: 1 \}\)/);
  assert.deepEqual(nodeByName(workflow, 'Configure Target Date').parameters.assignments.assignments, [{ id: '12000001-0000-4000-8000-000000000043', name: 'targetDate', value: '', type: 'string' }]);
  assert.ok(workflow.connections['Manually Trigger'].main[0].some(({ node }) => node === 'Configure Target Date'));
  assert.ok(workflow.connections['Configure Target Date'].main[0].some(({ node }) => node === 'Build Candidate Query Config'));
  assert.ok(workflow.nodes.every(({ type }) => type !== 'n8n-nodes-base.wait'));
  assert.equal(nodeByName(workflow, 'Resolve Stream Metadata').parameters.workflowId.value, 'StreamMetaV3A001');
  assert.equal(nodeByName(workflow, 'Resolve Stream Metadata').parameters.mode, 'each');
  assert.equal(nodeByName(workflow, 'Call Summary Orchestrator').parameters.workflowId.value, 'SummaryOrchV3A01');
  assert.equal(nodeByName(workflow, 'Call Summary Orchestrator').parameters.mode, 'each');
  const queryLogs = nodeByName(workflow, 'Call Query Steam Logs');
  assert.equal(queryLogs.parameters.workflowId.value, 'QueryLogsV3A0001');
  assert.equal(queryLogs.parameters.mode, 'once');
  assert.equal(queryLogs.parameters.options.waitForSubWorkflow, true);
  assert.equal(queryLogs.alwaysOutputData, true);
  assert.equal(queryLogs.onError, 'continueErrorOutput');
  assert.deepEqual(Object.keys(queryLogs.parameters.workflowInputs.value).sort(), ['channel', 'streamID', 'target_thread_ts']);
  assert.deepEqual(queryLogs.parameters.workflowInputs.schema.map(({ id, type, required }) => ({ id, type, required })), [
    { id: 'streamID', type: 'string', required: true },
    { id: 'channel', type: 'string', required: true },
    { id: 'target_thread_ts', type: 'string', required: true },
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
    [{ node: 'Summarize Query Log Results', type: 'main', index: 0 }],
    [{ node: 'Call Query Steam Logs', type: 'main', index: 0 }],
  ]);
  assert.deepEqual(workflow.connections['Call Query Steam Logs'].main, [
    [{ node: 'Mark Query Logs Success', type: 'main', index: 0 }],
    [{ node: 'Mark Query Logs Failure', type: 'main', index: 0 }],
  ]);
  assert.match(nodeByName(workflow, 'Mark Query Logs Failure').parameters.jsonOutput, /typeof error === 'string'/);
  assert.deepEqual(workflow.connections['Mark Query Logs Success'].main[0], [{ node: 'Query Logs Loop', type: 'main', index: 0 }]);
  assert.deepEqual(workflow.connections['Mark Query Logs Failure'].main[0], [{ node: 'Query Logs Loop', type: 'main', index: 0 }]);
  assert.equal(nodeByName(workflow, 'Summarize Query Log Results').parameters.jsCode, '__EXTERNAL_FILE__://nodes/Summarize_Query_Log_Results/jsCode.js');
  assert.deepEqual(workflow.connections['Summarize Query Log Results'].main[0], [{ node: 'All Query Logs Succeeded', type: 'main', index: 0 }]);
  assert.deepEqual(workflow.connections['All Query Logs Succeeded'].main, [
    [{ node: 'Limit Query Logs Loop Done', type: 'main', index: 0 }],
    [{ node: 'Fail Query Logs Delivery', type: 'main', index: 0 }],
  ]);
  assert.equal(nodeByName(workflow, 'Fail Query Logs Delivery').type, 'n8n-nodes-base.stopAndError');
  assert.equal(nodeByName(workflow, 'Fail Query Logs Delivery').parameters.errorMessage, '={{ $json.errorMessage }}');
  const queryLogsWorkflow = readQueryLogsWorkflow();
  const slackNodes = queryLogsWorkflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.slack');
  assert.equal(slackNodes.length, 7);
  for (const node of slackNodes) {
    assert.notEqual(node.retryOnFail, true, node.name);
    assert.equal(node.maxTries, undefined, node.name);
    assert.equal(node.waitBetweenTries, undefined, node.name);
  }
  assert.match(nodeByName(workflow, 'Send Monitoring Report').parameters.text, /自動化異常 Stream 監控報告/);
  assert.match(nodeByName(workflow, 'Send Candidate Detail').parameters.text, /自動化檢測詳情/);
  assert.ok(!workflow.nodes.some(({ name }) => name === 'Send Candidate Root'));
  assert.deepEqual(workflow.connections['Deduplicate Candidate Provenance'].main[0].map(({ node }) => node), ['Build Monitoring Report']);
  assert.deepEqual(workflow.connections['Send Monitoring Report'].main[0].map(({ node }) => node), ['Restore Candidate Items']);
  assert.deepEqual(workflow.connections['Candidate Is Eligible'].main[1].map(({ node }) => node), ['Send Candidate Eligibility Warning']);
  assert.equal(nodeByName(workflow, 'Candidate Is Eligible').parameters.conditions.conditions[0].operator.operation, 'empty');
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /Suspect stream summary request/);
  assert.doesNotMatch(serialized, /AISummaryV3A0001|sOSbXSfXFcMLeIfr|C09F0SYG57D/);
  for (const node of workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.dataTable')) {
    assert.deepEqual(node.parameters.dataTableId, { __rl: true, mode: 'name', value: 'suspect_stt_candidates_v3' });
  }
  assert.equal(nodeByName(workflow, 'Claim Candidate Root').parameters.matchType, 'allConditions');
  assert.equal(nodeByName(workflow, 'Checkpoint Candidate Root').parameters.matchType, 'allConditions');
  assert.doesNotThrow(() => buildWorkflow(workflowDir));
});
