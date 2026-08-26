const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowDir = path.resolve(__dirname, '..');
const { buildWorkflow } = require('../../../scripts/utils');
const {
  deduplicateCandidates,
  planCandidateReconciliation,
} = require('../nodes/Code_dedup/jsCode');
const {
  buildResolverCalls,
  chunkIDs,
} = require('../nodes/Chunk_Resolver_Input/jsCode');
const { reassembleContexts } = require('../nodes/Reassemble_Resolver_Output/jsCode');
const {
  buildRootCheckpointPlans,
  planRootOwnership,
  verifyRootCheckpoint,
  verifyRootClaim,
} = require('../nodes/Plan_Candidate_Root/jsCode');

const SQL_FILES = [
  'Comment_and_Caption_with_keywords1',
  'End_by_new_stream',
  'Caption_with_keywords',
  'Comment_and_Caption_with_keywords',
];

function readWorkflow() {
  return JSON.parse(fs.readFileSync(path.join(workflowDir, 'workflow.json'), 'utf8'));
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

test('uses the same parameterized two-day candidate bounds in all four SQL files', () => {
  for (const directory of SQL_FILES) {
    const sql = fs.readFileSync(path.join(workflowDir, 'nodes', directory, 'sqlQuery.sql'), 'utf8');
    assert.match(sql, /DECLARE queryEndDate TIMESTAMP DEFAULT TIMESTAMP\(@query_end\)/);
    assert.match(sql, /DECLARE queryStartDate TIMESTAMP DEFAULT TIMESTAMP_SUB\(queryEndDate, INTERVAL 2 DAY\)/);
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

test('deduplicates provenance and preserves an existing candidate canonical', () => {
  const candidates = deduplicateCandidates([
    { streamID: '9002', prevStreamID: '9001', userID: 'u1', metricSource: 'captionKeyword' },
    { streamID: '9002', prevStreamID: '9001', userID: 'u1', metricSource: 'endByNewStream' },
  ], { runID: 'run-1', nowIso: '2026-08-22T00:00:00.000Z' });
  assert.equal(candidates.length, 1);
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

test('is inactive, manual-only, C0-only, and routes resolver output only to the orchestrator', () => {
  const workflow = readWorkflow();
  assert.equal(workflow.active, false);
  const triggers = workflow.nodes.filter(({ type }) => /Trigger$/i.test(type));
  assert.deepEqual(triggers.map(({ type }) => type), ['n8n-nodes-base.manualTrigger']);
  assert.ok(workflow.nodes.every(({ type }) => !['n8n-nodes-base.wait', 'n8n-nodes-base.splitInBatches'].includes(type)));
  assert.equal(nodeByName(workflow, 'Resolve Stream Metadata').parameters.workflowId.value, 'StreamMetaV3A001');
  assert.equal(nodeByName(workflow, 'Call Summary Orchestrator').parameters.workflowId.value, 'SummaryOrchV3A01');
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /AISummaryV3A0001|sOSbXSfXFcMLeIfr|C09F0SYG57D/);
  for (const node of workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.dataTable')) {
    assert.deepEqual(node.parameters.dataTableId, { __rl: true, mode: 'name', value: 'suspect_stt_candidates_v3' });
  }
  assert.equal(nodeByName(workflow, 'Claim Candidate Root').parameters.matchType, 'allConditions');
  assert.equal(nodeByName(workflow, 'Checkpoint Candidate Root').parameters.matchType, 'allConditions');
  assert.doesNotThrow(() => buildWorkflow(workflowDir));
});
