const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowDir = path.resolve(__dirname, '..');
const workflowPath = path.join(workflowDir, 'workflow.json');
const schema = require('../../automation_provision_state_v3_AutomationProvV3A1/nodes/State_Schema/schema.json');
const { buildWorkflow } = require('../../../scripts/utils');
const { collectDataTableReferences, remapDataTableReferences } = require('../../../scripts/deploy-utils');
const { normalizeRequest } = require('../nodes/Normalize_Request/jsCode');
const { ATTEMPT_FIELDS, buildAttempts } = require('../nodes/Build_Attempts/jsCode');
const {
  IMMUTABLE_FIELDS,
  SUMMARY_FIELDS,
  buildSummaryRow,
  planCreationLease,
  planRequestReconciliation,
  verifyCreationOwner,
} = require('../nodes/Reconcile_Request/jsCode');
const { planAttemptReconciliation } = require('../nodes/Reconcile_Attempts/jsCode');
const { planOrphans } = require('../nodes/Plan_Orphans/jsCode');
const { verifyCoverage } = require('../nodes/Verify_Coverage/jsCode');
const { verifyTransition } = require('../nodes/Verify_Request_State/jsCode');
const { verifyOrphans } = require('../nodes/Verify_Orphans/jsCode');
const { acceptedResult } = require('../nodes/Return_Result/jsCode');
const { verifyAttemptInsert, verifyRequestInsert } = require('../nodes/Verify_Insert/jsCode');
const { verifyMutations } = require('../nodes/Verify_Reconciliation_Write/jsCode');
const { verifyDispatchAttempt } = require('../nodes/Verify_Dispatch_Attempt/jsCode');

const NOW = '2026-08-24T00:00:00.000Z';
const CHANNEL = 'C0A4JJJKJMD';

function stream(overrides = {}) {
  return {
    role: 'current',
    liveStreamID: '9001',
    mode: 'first',
    durationMinutes: 5,
    processingMessageTS: '1787364001.000002',
    streamContext: {
      liveStreamID: '9001', eligible: true, profile: 'stt', source: 'livestream_v2',
      userID: 'user-1', openID: 'open-1', region: 'TW', beginTime: 1787360400,
      endTime: 1787364000, duration: 3600, vliverModel: 0, appVersion: '1.2.3', deviceType: 'ios',
    },
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    requestKey: 'summary:req-001',
    requestType: 'suspect_summary',
    orderedStreams: [stream()],
    existingDialogues: {},
    channel: CHANNEL,
    threadTS: '1787364000.000001',
    ...overrides,
  };
}

function normalized(overrides = {}) {
  return normalizeRequest(input(overrides));
}

function requestRow(overrides = {}) {
  const canonical = normalized();
  return {
    id: 1, createdAt: NOW, updatedAt: NOW,
    ...buildSummaryRow(canonical, 'exec-1', NOW),
    reconciliationStatus: 'canonical', canonicalRowID: '1',
    ...overrides,
  };
}

function attemptRow(overrides = {}) {
  return {
    id: 1, createdAt: NOW, updatedAt: NOW,
    ...buildAttempts(normalized(), NOW)[0],
    reconciliationStatus: 'canonical', canonicalRowID: '1',
    ...overrides,
  };
}

function readWorkflow() {
  return JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
}

function nodeByName(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `Missing node: ${name}`);
  return node;
}

function targets(workflow, source, output = 0) {
  return (workflow.connections[source]?.main?.[output] || []).map(({ node }) => node);
}

function filterMap(node) {
  return Object.fromEntries((node.parameters.filters?.conditions || []).map((condition) => [condition.keyName, condition]));
}

function reachable(workflow, start) {
  const seen = new Set([start]);
  const pending = [start];
  while (pending.length) {
    const source = pending.pop();
    for (const output of workflow.connections[source]?.main || []) {
      for (const connection of output || []) {
        if (!seen.has(connection.node)) {
          seen.add(connection.node);
          pending.push(connection.node);
        }
      }
    }
  }
  return seen;
}

function ancestors(workflow, target) {
  const reverse = new Map();
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    for (const output of outputs.main || []) {
      for (const connection of output || []) {
        if (!reverse.has(connection.node)) reverse.set(connection.node, []);
        reverse.get(connection.node).push(source);
      }
    }
  }
  const seen = new Set();
  const pending = [...(reverse.get(target) || [])];
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(reverse.get(current) || []));
  }
  return seen;
}

test('normalizes aliases only at the boundary and preserves deterministic ordered context', () => {
  const result = normalized({
    orderedStreams: [
      stream(),
      stream({ role: 'previous', liveStreamID: '8001', mode: 'last', processingMessageTS: '1787364002.000003', streamContext: {
        ...stream().streamContext, liveStreamID: '8001', userID: 'user-2', openID: 'open-2',
      } }),
    ],
  });

  assert.deepEqual(result.orderedStreams.map(({ role, liveStreamID, mode }) => ({ role, liveStreamID, mode })), [
    { role: 'current', liveStreamID: '9001', mode: 'fromStart' },
    { role: 'previous', liveStreamID: '8001', mode: 'fromEnd' },
  ]);
  assert.equal(result.orderedStreamsJson, JSON.stringify(result.orderedStreams));
  assert.equal(result.existingDialoguesJson, '{}');
  assert.deepEqual(JSON.parse(result.expectedLogicalJobKeysJson), [
    'summary:req-001:current:9001:fromStart',
    'summary:req-001:previous:8001:fromEnd',
  ]);
  assert.equal(typeof result.orderedStreamsJson, 'string');
  assert.equal(typeof result.existingDialoguesJson, 'string');
  assert.equal(typeof result.expectedLogicalJobKeysJson, 'string');
});

test('fails closed on candidate ownership, duplicate roles, invalid routing, or incomplete dispatcher context', () => {
  assert.equal(Object.hasOwn(input(), 'candidateRows'), false);
  const invalid = [
    input({ channel: 'C09F0SYG57D' }),
    input({ threadTS: '1787364000' }),
    input({ candidateRows: [{ id: 'candidate-1' }], orderedStreams: [] }),
    input({ orderedStreams: [stream(), stream()] }),
    input({ orderedStreams: [stream({ liveStreamID: 9001 })] }),
    input({ orderedStreams: [stream({ durationMinutes: 0 })] }),
    input({ orderedStreams: [stream({ processingMessageTS: undefined })] }),
    input({ orderedStreams: [stream({ streamContext: { ...stream().streamContext, region: null } })] }),
    input({ orderedStreams: [stream({ streamContext: { ...stream().streamContext, endTime: 1787360400 } })] }),
    input({ orderedStreams: [stream({ streamContext: { ...stream().streamContext, profile: 'core' } })] }),
  ];
  for (const value of invalid) assert.throws(() => normalizeRequest(value));
  assert.throws(() => normalizeRequest({ ...input(), candidateRows: [] }), /not owned/i);
});

test('maps existing dialogue by role or exact logical identity and creates no attempt for it', () => {
  const byRole = normalized({ existingDialogues: { current: 'already transcribed' } });
  assert.deepEqual(byRole.existingDialogues, {
    current: { logicalJobKey: 'summary:req-001:current:9001:fromStart', dialogue: 'already transcribed' },
  });
  assert.deepEqual(byRole.expectedLogicalJobKeys, []);
  assert.deepEqual(buildAttempts(byRole, NOW), []);
  assert.equal(Object.hasOwn(byRole.orderedStreams[0], 'processingMessageTS'), false);

  const key = 'summary:req-001:current:9001:fromStart';
  const byKey = normalized({ existingDialogues: { [key]: { role: 'current', logicalJobKey: key, dialogue: 'persisted' } } });
  assert.deepEqual(buildAttempts(byKey, NOW), []);
  assert.throws(() => normalized({ existingDialogues: { current: 'one', [key]: 'two' } }), /ambiguous/i);
});

test('keeps unavailable stream context while creating attempts only for eligible streams', () => {
  for (const unavailableRole of ['previous', 'current']) {
    const previous = stream({
      role: 'previous', liveStreamID: '8001', mode: 'last', processingMessageTS: '1787364002.000003',
      streamContext: { ...stream().streamContext, liveStreamID: '8001', userID: 'user-2', openID: 'open-2' },
    });
    const current = stream();
    const unavailable = unavailableRole === 'previous' ? previous : current;
    unavailable.sttEligible = false;
    unavailable.processingMessageTS = undefined;
    unavailable.streamContext = { ...unavailable.streamContext, eligible: false, openID: null, missingFields: ['openID'] };
    const result = normalized({ orderedStreams: [previous, current] });
    const expectedRole = unavailableRole === 'previous' ? 'current' : 'previous';

    assert.equal(result.orderedStreams.length, 2);
    assert.equal(result.orderedStreams.find(({ role }) => role === unavailableRole).sttEligible, false);
    assert.equal(Object.hasOwn(result.orderedStreams.find(({ role }) => role === unavailableRole), 'processingMessageTS'), false);
    assert.equal(result.expectedLogicalJobKeys.length, 1);
    assert.match(result.expectedLogicalJobKeys[0], new RegExp(`:${expectedRole}:`));
    assert.equal(buildAttempts(result, NOW).length, 1);
  }
});

test('rejects requests with no STT attempt and no existing dialogue', () => {
  const unavailable = stream({
    sttEligible: false,
    processingMessageTS: undefined,
    streamContext: { ...stream().streamContext, eligible: false, openID: null, missingFields: ['openID'] },
  });
  assert.throws(() => normalized({ orderedStreams: [unavailable] }), /usable STT evidence/i);
});

test('initial coverage treats unavailable streams as missing without dispatching them', () => {
  const unavailable = stream({
    role: 'previous', liveStreamID: '8001', mode: 'last', sttEligible: false, processingMessageTS: undefined,
    streamContext: { ...stream().streamContext, liveStreamID: '8001', eligible: false, openID: null, missingFields: ['openID'] },
  });
  const result = normalized({ orderedStreams: [unavailable, stream()] });
  const attempts = buildAttempts(result, NOW).map((value, index) => ({
    id: 100 + index, createdAt: NOW, updatedAt: NOW, ...value,
    reconciliationStatus: 'canonical', canonicalRowID: String(100 + index),
  }));
  const coverage = verifyCoverage({
    ...requestRow(), orderedStreamsJson: result.orderedStreamsJson,
    existingDialoguesJson: result.existingDialoguesJson,
    expectedLogicalJobKeysJson: result.expectedLogicalJobKeysJson,
  }, attempts);

  assert.equal(coverage.status, 'waiting_stt');
  assert.equal(coverage.coverageStatus, 'waiting_stt');
  assert.deepEqual(JSON.parse(coverage.availableRolesJson), []);
  assert.deepEqual(JSON.parse(coverage.missingRolesJson), ['previous', 'current']);
  assert.equal(coverage.dispatchAttempts.length, 1);
});

test('builds exact Task 1 attempt schema and deterministic keys for missing dialogues', () => {
  const attempts = buildAttempts(normalized(), NOW);
  assert.equal(attempts.length, 1);
  assert.deepEqual(Object.keys(attempts[0]), ATTEMPT_FIELDS);
  assert.deepEqual(ATTEMPT_FIELDS, schema.stt_jobs_v3.map(({ name }) => name));
  assert.equal(attempts[0].logicalJobKey, 'summary:req-001:current:9001:fromStart');
  assert.equal(attempts[0].attemptKey, 'summary:req-001:current:9001:fromStart:1');
  assert.equal(attempts[0].processingMessageTS, '1787364001.000002');
  assert.equal(attempts[0].status, 'queued');
  assert.equal(attempts[0].reconciliationStatus, 'pending');
  assert.deepEqual(JSON.parse(attempts[0].streamContextJson), normalized().orderedStreams[0].streamContext);
  assert.ok(Object.values(attempts[0]).every((value) => ['string', 'number', 'boolean'].includes(typeof value)));
});

test('builds exact Task 1 creating request with a twenty-four-hour current execution lease', () => {
  const row = buildSummaryRow(normalized(), 'exec-1', NOW);
  assert.deepEqual(Object.keys(row), SUMMARY_FIELDS);
  assert.deepEqual(SUMMARY_FIELDS, schema.summary_requests_v3.map(({ name }) => name));
  assert.equal(row.status, 'creating');
  assert.equal(row.creationLeaseOwner, 'exec-1');
  assert.equal(row.creationLeaseUntilIso, '2026-08-25T00:00:00.000Z');
  assert.equal(row.reconciliationStatus, 'pending');
  assert.ok(Object.values(row).every((value) => ['string', 'number', 'boolean'].includes(typeof value)));
});

test('preserves one canonical, elects system earliest only when absent, and converges clean duplicates', () => {
  const canonical = requestRow({ id: 26, canonicalRowID: '26' });
  const pending = requestRow({ id: 1, createdAt: '2026-08-24T00:01:00.000Z', reconciliationStatus: 'pending', canonicalRowID: '' });
  const preserved = planRequestReconciliation([canonical, pending], normalized());
  assert.equal(preserved.winnerRowID, 26);
  assert.equal(preserved.mutations[0].desiredReconciliationStatus, 'duplicate');

  const elected = planRequestReconciliation([
    requestRow({ id: 2, reconciliationStatus: 'pending', canonicalRowID: '' }),
    requestRow({ id: 1, reconciliationStatus: 'pending', canonicalRowID: '' }),
  ], normalized());
  assert.equal(elected.winnerRowID, 1);
  assert.equal(elected.mutations.find(({ id }) => id === 1).desiredReconciliationStatus, 'canonical');

  const competing = planRequestReconciliation([
    requestRow({ id: 2, canonicalRowID: '2' }),
    requestRow({ id: 1, canonicalRowID: '1' }),
  ], normalized());
  assert.equal(competing.action, 'reconcile');
  assert.equal(competing.winnerRowID, 1);
});

test('freezes every checkpoint-bearing competing canonical with an allowlisted original stage', () => {
  const rows = [
    requestRow({ id: 1, canonicalRowID: '1', status: 'ready' }),
    requestRow({ id: 2, canonicalRowID: '2', status: 'summary_dispatching', summaryMarkdown: 'checkpoint' }),
  ];
  const plan = planRequestReconciliation(rows, normalized());
  assert.equal(plan.action, 'manual_review');
  assert.equal(plan.reason, 'multiple_canonical_checkpoint_conflict');
  assert.deepEqual(plan.mutations.map(({ manualReviewOriginalStage }) => manualReviewOriginalStage), ['ready', 'summary_dispatching']);
  assert.throws(() => planRequestReconciliation([
    requestRow({ id: 1, canonicalRowID: '1', status: 'creating' }),
    requestRow({ id: 2, canonicalRowID: '2', status: 'creating', summaryMarkdown: 'invalid checkpoint' }),
  ], normalized()), /invalid original stage/i);
});

test('rejects same requestKey with any immutable payload drift before claim or dispatch', () => {
  for (const field of IMMUTABLE_FIELDS.filter((name) => name !== 'requestKey')) {
    const row = requestRow({ [field]: `${requestRow()[field]}-different` });
    assert.throws(() => planRequestReconciliation([row], normalized()), new RegExp(field));
  }
  const later = requestRow({ status: 'completed' });
  const plan = planRequestReconciliation([later], normalized());
  assert.equal(plan.action, 'ready');
  assert.deepEqual(planCreationLease(plan.canonical, 'exec-2', NOW), { action: 'accepted', canonical: later });
});

test('handles current, expired, empty, and active foreign creation leases without stealing', () => {
  assert.equal(planCreationLease(requestRow(), 'exec-1', NOW).action, 'resume');
  assert.equal(planCreationLease(requestRow({ creationLeaseOwner: '', creationLeaseUntilIso: '' }), 'exec-2', NOW).action, 'claim');
  assert.equal(planCreationLease(requestRow({ creationLeaseOwner: 'exec-old', creationLeaseUntilIso: '2026-08-23T23:59:59.000Z' }), 'exec-2', NOW).action, 'claim');
  assert.equal(planCreationLease(requestRow({ creationLeaseOwner: 'exec-other' }), 'exec-2', NOW).action, 'blocked');
  assert.throws(() => verifyCreationOwner([requestRow()], 'summary:req-001', 'exec-other', NOW), /does not own/i);
  assert.equal(verifyCreationOwner([requestRow()], 'summary:req-001', 'exec-1', NOW).id, 1);
});

test('recovers partial attempt insertion with the same keys and requires complete readable coverage', () => {
  const multi = normalized({
    orderedStreams: [
      stream(),
      stream({ role: 'previous', liveStreamID: '8001', mode: 'last', processingMessageTS: '1787364002.000003', streamContext: { ...stream().streamContext, liveStreamID: '8001' } }),
    ],
  });
  const expected = buildAttempts(multi, NOW);
  assert.equal(expected.length, 2);
  const first = { id: 101, createdAt: NOW, updatedAt: NOW, ...expected[0], reconciliationStatus: 'canonical', canonicalRowID: '101' };
  assert.throws(() => verifyCoverage({ ...requestRow(), orderedStreamsJson: multi.orderedStreamsJson, existingDialoguesJson: multi.existingDialoguesJson, expectedLogicalJobKeysJson: multi.expectedLogicalJobKeysJson }, [first]), /not readable/i);
  const secondPlan = planAttemptReconciliation([], expected[1]);
  assert.equal(secondPlan.action, 'insert');
  const second = { id: 102, createdAt: NOW, updatedAt: NOW, ...expected[1], reconciliationStatus: 'canonical', canonicalRowID: '102' };
  const coverage = verifyCoverage({ ...requestRow(), orderedStreamsJson: multi.orderedStreamsJson, existingDialoguesJson: multi.existingDialoguesJson, expectedLogicalJobKeysJson: multi.expectedLogicalJobKeysJson }, [first, second]);
  assert.equal(coverage.status, 'waiting_stt');
  assert.deepEqual(coverage.dispatchAttempts.map(({ attemptKey }) => attemptKey), expected.map(({ attemptKey }) => attemptKey));
});

test('reconciles each unexpected attempt key before deleting clean orphan rows', () => {
  const expectedKeys = [attemptRow().attemptKey];
  const clean = attemptRow({ id: 201, attemptKey: 'summary:req-001:orphan:9999:fromStart:1', logicalJobKey: 'summary:req-001:orphan:9999:fromStart', reconciliationStatus: 'pending', canonicalRowID: '' });
  const reconciliation = planOrphans([attemptRow(), clean], expectedKeys, []);
  assert.equal(reconciliation.action, 'reconcile');
  assert.equal(reconciliation.mutations[0].desiredReconciliationStatus, 'canonical');
  assert.equal(reconciliation.mutations[0].desiredCanonicalRowID, '201');

  const canonical = { ...clean, reconciliationStatus: 'canonical', canonicalRowID: String(clean.id) };
  const deletion = planOrphans([attemptRow(), canonical], expectedKeys, []);
  assert.equal(deletion.action, 'delete');
  assert.deepEqual(deletion.mutations.map(({ id }) => id), [201]);
  assert.deepEqual(verifyOrphans([attemptRow()], deletion.mutations), [{ json: { orphanAction: 'replan' } }]);
  assert.throws(() => verifyOrphans([canonical], deletion.mutations), /still exists/i);
});

test('marks only a reconciled checkpointed orphan canonical for manual review', () => {
  const expectedKeys = [attemptRow().attemptKey];
  const pending = attemptRow({ id: 202, attemptKey: 'summary:req-001:orphan:9999:fromStart:1', logicalJobKey: 'summary:req-001:orphan:9999:fromStart', reconciliationStatus: 'pending', canonicalRowID: '', submittedAtIso: NOW });
  const reconciliation = planOrphans([pending], expectedKeys, []);
  assert.equal(reconciliation.action, 'reconcile');
  assert.equal(reconciliation.mutations[0].desiredStatus, pending.status);

  const canonical = { ...pending, reconciliationStatus: 'canonical', canonicalRowID: String(pending.id) };
  const duplicate = attemptRow({ ...canonical, id: 203, reconciliationStatus: 'duplicate', canonicalRowID: String(canonical.id) });
  const blocked = planOrphans([canonical, duplicate], expectedKeys, []);
  assert.equal(blocked.action, 'manual_review');
  assert.deepEqual(blocked.mutations.map(({ id }) => id), [202]);
  assert.equal(blocked.mutations[0].desiredStatus, 'manual_review');
  assert.deepEqual(verifyOrphans([{ ...canonical, status: 'manual_review' }, duplicate], blocked.mutations), []);
});

test('blocks deletion when a single canonical orphan has only a matching Summary checkpoint', () => {
  const expectedKeys = [attemptRow().attemptKey];
  const canonical = attemptRow({
    id: 204,
    attemptKey: 'summary:req-001:orphan:9999:fromStart:1',
    logicalJobKey: 'summary:req-001:orphan:9999:fromStart',
    canonicalRowID: '204',
  });
  const plan = planOrphans([canonical], expectedKeys, [requestRow({ summaryMarkdown: 'persisted summary' })]);

  assert.equal(plan.action, 'manual_review');
  assert.deepEqual(plan.mutations.map(({ id }) => id), [204]);
  assert.equal(plan.mutations[0].desiredReconciliationStatus, 'canonical');
  assert.equal(plan.mutations[0].desiredStatus, 'manual_review');
  assert.deepEqual(verifyOrphans([{ ...canonical, status: 'manual_review' }], plan.mutations), []);
});

test('reconciles attempt duplicates with Task 4 cross-table checkpoint parity', () => {
  const expected = buildAttempts(normalized(), NOW)[0];
  const cleanPlan = planAttemptReconciliation([
    attemptRow({ id: 102, canonicalRowID: '102' }),
    attemptRow({ id: 101, canonicalRowID: '101' }),
  ], expected);
  assert.equal(cleanPlan.action, 'reconcile');
  assert.equal(cleanPlan.winnerRowID, 101);

  const competing = [
    attemptRow({ id: 101, canonicalRowID: '101' }),
    attemptRow({ id: 102, canonicalRowID: '102' }),
  ];
  const conflict = planAttemptReconciliation(competing, expected, [requestRow({ summaryMarkdown: 'checkpoint' })]);
  assert.equal(conflict.action, 'manual_review');
  assert.equal(conflict.mutations.length, 2);
  assert.throws(() => planAttemptReconciliation(competing, expected, [requestRow({ requestKey: 'summary:req-other' })]), /summary request key mismatch/i);
  assert.throws(() => planAttemptReconciliation([
    competing[0], { ...competing[1], requestKey: 'summary:req-other' },
  ], expected, []), /attempt request key mismatch/i);
  assert.throws(() => planAttemptReconciliation([attemptRow({ mode: 'fromEnd' })], expected), /immutable attempt payload conflict/i);
});

test('transitions all-dialogue requests directly to ready and missing-dialogue requests to waiting_stt', () => {
  const allDialogue = normalized({ existingDialogues: { current: 'ready dialogue' } });
  const ready = verifyCoverage({ ...requestRow(), orderedStreamsJson: allDialogue.orderedStreamsJson, existingDialoguesJson: allDialogue.existingDialoguesJson, expectedLogicalJobKeysJson: allDialogue.expectedLogicalJobKeysJson }, []);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.coverageStatus, 'complete');
  assert.deepEqual(ready.dispatchAttempts, []);

  const waiting = verifyCoverage(requestRow(), [attemptRow()]);
  assert.equal(waiting.status, 'waiting_stt');
  assert.deepEqual(JSON.parse(waiting.missingRolesJson), ['current']);
  assert.deepEqual(waiting.dispatchAttempts, [{ attemptKey: attemptRow().attemptKey }]);
});

test('detects zero-CAS or partial final transition and returns only the natural allowlist', () => {
  const plan = {
    ...requestRow(), status: 'waiting_stt', coverageStatus: 'waiting_stt', availableRolesJson: '[]',
    missingRolesJson: '["current"]', failedLogicalJobKeysJson: '[]', expectedCreationLeaseOwner: 'exec-1',
    dispatchAttempts: [{ attemptKey: attemptRow().attemptKey }],
  };
  const persisted = {
    ...requestRow(), status: 'waiting_stt', coverageStatus: 'waiting_stt', availableRolesJson: '[]',
    missingRolesJson: '["current"]', failedLogicalJobKeysJson: '[]', creationLeaseOwner: '', creationLeaseUntilIso: '',
  };
  assert.equal(verifyTransition([persisted], plan, 'exec-1').transitionAction, 'waiting_stt');
  assert.throws(() => verifyTransition([], plan, 'exec-1'), /exactly one canonical/i);
  assert.throws(() => verifyTransition([{ ...persisted, missingRolesJson: '[]' }], plan, 'exec-1'), /not persisted exactly/i);
  assert.deepEqual(acceptedResult({ ...persisted, orderedStreamsJson: 'secret', id: 'internal' }), {
    accepted: true, requestKey: 'summary:req-001', requestType: 'suspect_summary',
    status: 'waiting_stt', channel: CHANNEL, threadTS: '1787364000.000001',
  });
});

test('fails closed on zero-CAS inserts, partial reconciliation writes, and stale dispatch rows', () => {
  const expectedAttempt = buildAttempts(normalized(), NOW)[0];
  assert.throws(() => verifyRequestInsert([], normalized()), /zero-CAS/i);
  assert.throws(() => verifyAttemptInsert([], expectedAttempt), /zero-CAS/i);
  assert.equal(verifyRequestInsert([requestRow()], normalized()).length, 1);
  assert.equal(verifyAttemptInsert([attemptRow()], expectedAttempt).length, 1);

  const mutations = [
    { id: 1, desiredReconciliationStatus: 'canonical', desiredCanonicalRowID: '1' },
    { id: 2, desiredReconciliationStatus: 'duplicate', desiredCanonicalRowID: '1' },
  ];
  assert.throws(() => verifyMutations([requestRow()], mutations), /partial|not persisted/i);
  assert.equal(verifyMutations([
    requestRow(),
    requestRow({ id: 2, reconciliationStatus: 'duplicate', canonicalRowID: '1' }),
  ], mutations).length, 2);

  assert.deepEqual(verifyDispatchAttempt([attemptRow()], attemptRow().attemptKey), { attemptKey: attemptRow().attemptKey });
  assert.throws(() => verifyDispatchAttempt([{ ...attemptRow(), status: 'dispatching' }], attemptRow().attemptKey), /canonical queued/i);
  assert.throws(() => verifyDispatchAttempt([
    attemptRow(), attemptRow({ id: 102, canonicalRowID: '102' }),
  ], attemptRow().attemptKey), /canonical queued/i);
});

test('defines the exact inactive typed subworkflow contract without candidate rows or credentials', () => {
  const workflow = readWorkflow();
  const triggers = workflow.nodes.filter(({ type }) => type.toLowerCase().includes('trigger'));
  assert.equal(workflow.id, 'SummaryOrchV3A01');
  assert.equal(workflow.name, 'Summary: orchestrate request v3');
  assert.equal(workflow.active, false);
  assert.equal(workflow.isArchived, false);
  assert.deepEqual(triggers.map(({ type }) => type), ['n8n-nodes-base.executeWorkflowTrigger']);
  assert.deepEqual(triggers[0].parameters.workflowInputs.values, [
    { name: 'requestKey', type: 'string' }, { name: 'requestType', type: 'string' },
    { name: 'orderedStreams', type: 'array' }, { name: 'existingDialogues', type: 'object' },
    { name: 'channel', type: 'string' }, { name: 'threadTS', type: 'string' },
  ]);
  assert.doesNotMatch(JSON.stringify(triggers[0]), /candidate/i);
  assert.ok(workflow.nodes.every((node) => !node.credentials));
});

test('uses only authoritative by-name state tables and exact allConditions soft-CAS writes', () => {
  const workflow = readWorkflow();
  const dataTables = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.dataTable');
  const updates = dataTables.filter(({ parameters }) => parameters.operation === 'update');
  const deletes = dataTables.filter(({ parameters }) => parameters.operation === 'deleteRows');
  const reads = dataTables.filter(({ parameters }) => parameters.operation === 'get');
  assert.equal(collectDataTableReferences([workflow]).length, dataTables.length);
  for (const node of dataTables) {
    assert.equal(node.typeVersion, 1, node.name);
    assert.equal(node.parameters.dataTableId.__rl, true, node.name);
    assert.equal(node.parameters.dataTableId.mode, 'name', node.name);
    assert.ok(['summary_requests_v3', 'stt_jobs_v3'].includes(node.parameters.dataTableId.value), node.name);
  }
  for (const node of reads) {
    assert.equal(node.parameters.returnAll, true, node.name);
    assert.equal(node.alwaysOutputData, true, node.name);
  }
  for (const node of updates) {
    assert.equal(node.parameters.matchType, 'allConditions', node.name);
    assert.equal(node.parameters.columns.mappingMode, 'defineBelow', node.name);
    assert.equal(node.alwaysOutputData, true, node.name);
    const next = targets(workflow, node.name);
    assert.equal(next.length, 1, node.name);
    const limit = nodeByName(workflow, next[0]);
    assert.equal(limit.type, 'n8n-nodes-base.limit', node.name);
    assert.equal(limit.parameters.maxItems, 1, node.name);
    const rereads = targets(workflow, limit.name);
    assert.equal(rereads.length, 1, limit.name);
    assert.equal(nodeByName(workflow, rereads[0]).parameters.operation, 'get', limit.name);
  }
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].name, 'Delete Clean Orphan Rows');
  assert.equal(deletes[0].parameters.matchType, 'allConditions');
  assert.equal(deletes[0].alwaysOutputData, true);
  assert.ok(Object.keys(filterMap(deletes[0])).includes('id'));
  assert.ok(Object.keys(filterMap(deletes[0])).includes('requestKey'));
  assert.ok(Object.keys(filterMap(deletes[0])).includes('updatedAt'));

  const runtimeNodes = remapDataTableReferences(workflow.nodes, new Map([
    ['suspect_stt_candidates_v3', 'candidates-id'], ['stt_jobs_v3', 'jobs-id'],
    ['summary_requests_v3', 'summary-id'], ['automation_errors_v3', 'errors-id'],
  ]));
  assert.ok(runtimeNodes.filter(({ type }) => type === 'n8n-nodes-base.dataTable')
    .every(({ parameters }) => parameters.dataTableId.mode === 'id'));
});

test('enforces exact request claim and final transition CAS filters', () => {
  const workflow = readWorkflow();
  const claim = filterMap(nodeByName(workflow, 'Claim Creation Lease'));
  assert.deepEqual(Object.keys(claim), [
    'id', 'requestKey', 'status', 'reconciliationStatus', 'canonicalRowID',
    'creationLeaseOwner', 'creationLeaseUntilIso',
  ]);
  assert.equal(claim.status.keyValue, 'creating');
  assert.equal(claim.reconciliationStatus.keyValue, 'canonical');
  assert.equal(nodeByName(workflow, 'Claim Creation Lease').parameters.columns.value.creationLeaseUntilIso, '={{ $now.plus({ hours: 24 }).toUTC().toISO() }}');

  const transition = filterMap(nodeByName(workflow, 'Transition Request State'));
  assert.deepEqual(Object.keys(transition), [
    'id', 'requestKey', 'status', 'creationLeaseOwner', 'creationLeaseUntilIso',
    'reconciliationStatus', 'canonicalRowID',
  ]);
  assert.equal(transition.creationLeaseOwner.keyValue, '={{ $execution.id }}');
  assert.equal(nodeByName(workflow, 'Transition Request State').parameters.columns.value.creationLeaseOwner, '');
  assert.equal(nodeByName(workflow, 'Transition Request State').parameters.columns.value.creationLeaseUntilIso, '');
});

test('dispatches only after verified request transition and never redispatches accepted replay states', () => {
  const workflow = readWorkflow();
  const dispatchAncestors = ancestors(workflow, 'Dispatch Verified Attempts');
  const coordinatorAncestors = ancestors(workflow, 'Run Summary Coordinator');
  assert.ok(dispatchAncestors.has('Verify Request Transition'));
  assert.ok(dispatchAncestors.has('Transition Request State'));
  assert.ok(coordinatorAncestors.has('Verify Request Transition'));
  assert.ok(coordinatorAncestors.has('Transition Request State'));
  assert.equal(reachable(workflow, 'Plan Creation Lease').has('Dispatch Verified Attempts'), true);
  assert.deepEqual(targets(workflow, 'Current Creation Owner', 1), ['Return Accepted Request']);
  assert.equal(reachable(workflow, 'Return Accepted Request').has('Dispatch Verified Attempts'), false);
  assert.equal(reachable(workflow, 'Return Accepted Request').has('Run Summary Coordinator'), false);

  const dispatch = nodeByName(workflow, 'Dispatch Verified Attempts');
  assert.equal(dispatch.parameters.workflowId.value, 'STTDispatchV3A01');
  assert.deepEqual(dispatch.parameters.workflowInputs.value, { attemptKey: '={{ $json.attemptKey }}' });
  assert.equal(dispatch.parameters.options.waitForSubWorkflow, false);
  assert.deepEqual(targets(workflow, 'Verify Canonical Queued Dispatch'), ['Dispatch Verified Attempts', 'Dispatch Verification Loop']);
  assert.deepEqual(targets(workflow, 'Dispatch Verified Attempts'), ['Drop Side Effect Output']);
  assert.deepEqual(targets(workflow, 'Dispatch Verification Loop', 0), ['Drop Side Effect Output']);
  assert.deepEqual(targets(workflow, 'Re-read Attempt Before Dispatch'), ['Verify Canonical Queued Dispatch']);
  const coordinator = nodeByName(workflow, 'Run Summary Coordinator');
  assert.equal(coordinator.parameters.workflowId.value, 'SummaryCoordV3A1');
  assert.deepEqual(coordinator.parameters.workflowInputs.value, { requestKey: '={{ $json.requestKey }}' });
  assert.equal(coordinator.parameters.options.waitForSubWorkflow, false);
  assert.deepEqual(targets(workflow, 'Run Summary Coordinator'), ['Drop Side Effect Output']);
});

test('assembles every external file and keeps UUIDs, references, reachability, and terminal conflicts valid', () => {
  const source = readWorkflow();
  const assembled = buildWorkflow(workflowDir);
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.ok(source.nodes.every(({ id }) => uuidV4.test(id)));
  assert.equal(new Set(source.nodes.map(({ id }) => id)).size, source.nodes.length);
  assert.equal(new Set(source.nodes.map(({ name }) => name)).size, source.nodes.length);
  assert.ok(assembled.nodes.every((node) => !JSON.stringify(node.parameters).includes('__EXTERNAL_FILE__://')));
  const names = new Set(source.nodes.map(({ name }) => name));
  for (const outputs of Object.values(source.connections)) {
    for (const output of outputs.main || []) {
      for (const connection of output || []) assert.ok(names.has(connection.node), connection.node);
    }
  }
  const allReachable = reachable(source, 'Start');
  assert.equal(allReachable.size, source.nodes.length);
  assert.deepEqual(targets(source, 'Verify Frozen Requests'), []);
  assert.deepEqual(targets(source, 'Verify Frozen Attempts'), []);
  assert.equal(reachable(source, 'Freeze Request Plan').has('Dispatch Verified Attempts'), false);
  assert.equal(reachable(source, 'Freeze Attempt Plan').has('Dispatch Verified Attempts'), false);
  const terminals = source.nodes.filter((node) => targets(source, node.name).length === 0).map(({ name }) => name);
  assert.ok(terminals.includes('Return Accepted Request'));
  assert.ok(terminals.includes('Drop Side Effect Output'));
  assert.ok(source.connections['Drop Side Effect Output'] === undefined);
  assert.equal(fs.readFileSync(path.join(workflowDir, 'nodes/Drop_Side_Effect_Output/jsCode.js'), 'utf8').trim(), 'return [];');
});

test('uses no logs, secrets, candidate table, legacy table, or retained execution payloads', () => {
  const workflow = readWorkflow();
  const code = fs.readdirSync(path.join(workflowDir, 'nodes'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => fs.readFileSync(path.join(workflowDir, 'nodes', entry.name, 'jsCode.js'), 'utf8'))
    .join('\n');
  assert.doesNotMatch(code, /console\.(?:log|debug|info|warn|error)/);
  assert.doesNotMatch(JSON.stringify(workflow), /suspect_stt_candidates_v3|AISummaryV2|C09F0SYG57D/);
  assert.doesNotMatch(JSON.stringify(workflow), /api[_-]?key|"callbackToken"|"credentials"/i);
  assert.deepEqual(workflow.settings, {
    executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all',
    saveManualExecutions: true, saveExecutionProgress: false,
  });
});
