const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { collectDataTableReferences, remapDataTableReferences } = require('../../../scripts/deploy-utils');

const workflowDir = path.resolve(__dirname, '..');
const workflow = JSON.parse(fs.readFileSync(path.join(workflowDir, 'workflow.json'), 'utf8'));
const state = require(path.join(workflowDir, 'nodes', 'Presentation_State', 'jsCode.js'));
const reconciliation = require(path.join(workflowDir, 'nodes', 'Reconcile_Canonical', 'jsCode.js'));
const transcript = require(path.join(workflowDir, 'nodes', 'Convert_Trans_to_Txt', 'jsCode.js'));
const analysisFormat = require(path.join(workflowDir, 'nodes', 'Format_Analysis_Data', 'jsCode.js'));
const analysis = analysisFormat;

const PINNED_SLACK_2_3_UPLOAD_ITEMS = [
  { json: { id: 'F08ABC123', name: 'stt.txt', mimetype: 'text/plain' } },
];

const NOW = '2026-08-22T00:00:00.000Z';
const ATTEMPT_KEY = 'summary:req-001:current:9001:fromStart:1';
const P3_IDS = new Map([
  ['stt_jobs_v3', 'p3-jobs'],
  ['summary_requests_v3', 'p3-summaries'],
  ['automation_errors_v3', 'p3-errors'],
]);
const FAILURE_CATEGORIES = {
  'Failure Source Claim Owner': {
    failureSource: 'claim_owner', errorCode: 'presentation_claim_owner_failed', potentialDuplicateUpload: false,
    sources: ['Verify Presentation Claim'],
  },
  'Failure Source Side Effect Guard': {
    failureSource: 'side_effect_guard', errorCode: 'presentation_side_effect_guard_failed', potentialDuplicateUpload: false,
    sources: [
      'Read Before Side Effect', 'Read Summary Before Side Effect', 'Guard Side Effect Owner',
      'Apply Side Effect Reconciliation', 'Post-claim Freeze Canonical Conflict',
      'Re-read Post-claim Frozen Conflict', 'Verify Post-claim Full Freeze',
    ],
  },
  'Failure Source Transcript': {
    failureSource: 'transcript', errorCode: 'presentation_transcript_failed', potentialDuplicateUpload: false,
    sources: ['Translate Dialogue', 'Prepare Transcript File', 'Upload Transcript File', 'Extract Transcript Upload ID'],
  },
  'Failure Source Transcript Checkpoint': {
    failureSource: 'transcript_checkpoint', errorCode: 'potential_duplicate_upload', potentialDuplicateUpload: true,
    sources: ['Checkpoint Transcript Upload', 'Verify Transcript Checkpoint'],
  },
  'Failure Source Analysis': {
    failureSource: 'analysis', errorCode: 'presentation_analysis_failed', potentialDuplicateUpload: false,
    sources: ['Analyze Dialogue', 'Prepare Analysis File', 'Upload Analysis File', 'Extract Analysis Upload ID'],
  },
  'Failure Source Analysis Checkpoint': {
    failureSource: 'analysis_checkpoint', errorCode: 'potential_duplicate_upload', potentialDuplicateUpload: true,
    sources: ['Checkpoint Analysis Upload', 'Verify Analysis Checkpoint'],
  },
  'Failure Source Message Update': {
    failureSource: 'message_update', errorCode: 'presentation_message_update_failed', potentialDuplicateUpload: false,
    sources: [
      'Update Processing Message', 'Prepare Message Checkpoint', 'Checkpoint Processing Message',
      'Verify Message Checkpoint',
    ],
  },
  'Failure Source Completion': {
    failureSource: 'complete', errorCode: 'presentation_complete_failed', potentialDuplicateUpload: false,
    sources: ['Prepare Completion Snapshot', 'Complete Presentation', 'Verify Completion'],
  },
};
const POSTCLAIM_FAILURE_SOURCE = Object.fromEntries(Object.entries(FAILURE_CATEGORIES)
  .flatMap(([constant, category]) => category.sources.map((source) => [source, constant])));

function row(overrides = {}) {
  const result = {
    id: 1, createdAt: NOW, updatedAt: NOW,
    attemptKey: ATTEMPT_KEY, requestKey: 'summary:req-001', logicalJobKey: 'summary:req-001:current:9001:fromStart',
    requestType: 'suspect', role: 'current', attempt: 1, streamID: '9001', mode: 'fromStart', durationMinutes: 5,
    status: 'completed', dialogue: 'hello world', language: 'en', channel: 'C0A4JJJKJMD',
    threadTS: '1787364000.000001', processingMessageTS: '1787364001.000002',
    reconciliationStatus: 'canonical', canonicalRowID: '1', presentationStatus: 'pending',
    presentationLeaseOwner: '', presentationLeaseUntilIso: '', presentationAttempt: 0,
    presentationNextRetryAtIso: '', presentationErrorCode: '', transcriptUploadID: '', analysisUploadID: '',
    processingMessageUpdatedAtIso: '', submittedAtIso: '', callbackDeadlineAtIso: '', consumedAtIso: '',
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'canonicalRowID')) result.canonicalRowID = String(result.id);
  return result;
}

function node(name) {
  const found = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(found, `Missing node: ${name}`);
  return found;
}

function targets(source, output = 0) {
  return (workflow.connections[source]?.main?.[output] || []).map(({ node: target }) => target);
}

function filters(name) {
  return Object.fromEntries(node(name).parameters.filters.conditions.map((condition) => [condition.keyName, condition]));
}

function reachable(start) {
  const seen = new Set();
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

test('is inactive with one typed Define Below attemptKey trigger and documented contract', () => {
  assert.equal(workflow.active, false);
  const triggers = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.executeWorkflowTrigger');
  assert.equal(triggers.length, 1);
  assert.deepEqual(triggers[0].parameters.workflowInputs.values, [{ name: 'attemptKey', type: 'string' }]);
  assert.equal('inputSource' in triggers[0].parameters, false);
  assert.match(workflow.description, /Input: required attemptKey string/);
  assert.match(workflow.description, /Side effects:/);
  assert.match(workflow.description, /Output:/);
  assert.match(workflow.description, /require Automation: error handler v3 assignment before activation/);
  assert.equal(workflow.nodes.some(({ type }) => type === 'n8n-nodes-base.webhook'), false);
});

test('validates attemptKey and uses exact twenty-four-hour presentation lease', () => {
  assert.equal(state.validateAttemptKey(ATTEMPT_KEY), ATTEMPT_KEY);
  for (const value of ['', ' bad', 'bad ', null, 1]) assert.throws(() => state.validateAttemptKey(value));
  assert.equal(state.presentationLeaseExpiry(NOW), '2026-08-23T00:00:00.000Z');
  assert.equal(node('Claim Presentation').parameters.columns.value.presentationLeaseUntilIso, '={{ $now.toUTC().plus({ hours: 24 }).toISO() }}');
});

test('limits presentation mutations to the exact plan allowlist', () => {
  assert.deepEqual(state.PRESENTATION_MUTATION_FIELDS, [
    'presentationStatus', 'presentationLeaseOwner', 'presentationLeaseUntilIso', 'presentationAttempt',
    'presentationNextRetryAtIso', 'presentationErrorCode', 'transcriptUploadID', 'analysisUploadID',
    'processingMessageUpdatedAtIso', 'updatedAtIso',
  ]);
  const presentationWrites = [
    'Claim Presentation', 'Checkpoint Transcript Upload', 'Checkpoint Analysis Upload',
    'Checkpoint Processing Message', 'Complete Presentation', 'Patch Presentation Failure',
  ];
  const allowed = new Set(state.PRESENTATION_MUTATION_FIELDS);
  for (const name of presentationWrites) {
    assert.ok(Object.keys(node(name).parameters.columns.value).every((key) => allowed.has(key)), name);
  }
  const serialized = JSON.stringify(presentationWrites.map((name) => node(name).parameters.columns.value));
  for (const forbidden of ['dialogue', 'language', 'callbackTokenHash', 'consumedAtIso', 'nextRetryAtIso']) {
    assert.doesNotMatch(serialized, new RegExp(`"${forbidden}"`));
  }
});

test('separates clean reconciliation and freeze mutation governance', () => {
  assert.deepEqual(state.CLEAN_RECONCILIATION_MUTATION_FIELDS, [
    'reconciliationStatus', 'canonicalRowID', 'updatedAtIso',
  ]);
  assert.deepEqual(state.FREEZE_MUTATION_FIELDS, [
    'status', 'manualReviewReason', 'manualReviewAtIso',
    'presentationLeaseOwner', 'presentationLeaseUntilIso', 'updatedAtIso',
  ]);
  const cleanAllowed = new Set(state.CLEAN_RECONCILIATION_MUTATION_FIELDS);
  for (const name of ['Apply Initial Reconciliation', 'Apply Side Effect Reconciliation']) {
    assert.ok(Object.keys(node(name).parameters.columns.value).every((key) => cleanAllowed.has(key)), name);
  }
  const freezeAllowed = new Set(state.FREEZE_MUTATION_FIELDS);
  for (const name of ['Freeze Canonical Conflict', 'Post-claim Freeze Canonical Conflict']) {
    assert.ok(Object.keys(node(name).parameters.columns.value).every((key) => freezeAllowed.has(key)), name);
  }
});

test('uses exact source table placeholders and proven deploy remap', () => {
  const refs = collectDataTableReferences([workflow]);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.ok(P3_IDS.has(ref.tableName), ref.nodeName);
  }
  const completeIds = new Map([
    ['suspect_stt_candidates_v3', 'p3-suspects'],
    ...P3_IDS,
  ]);
  const remapped = remapDataTableReferences(workflow.nodes, completeIds);
  for (const tableNode of remapped.filter(({ type }) => type === 'n8n-nodes-base.dataTable')) {
    assert.deepEqual(tableNode.parameters.dataTableId, { __rl: true, mode: 'id', value: P3_IDS.get(node(tableNode.name).parameters.dataTableId.value) });
  }
});

test('makes every read return all rows with alwaysOutputData', () => {
  const reads = workflow.nodes.filter(({ type, parameters }) => type === 'n8n-nodes-base.dataTable' && parameters.operation === 'get');
  assert.ok(reads.length >= 10);
  for (const read of reads) {
    assert.equal(read.parameters.returnAll, true, read.name);
    assert.equal(read.parameters.matchType, 'allConditions', read.name);
    assert.equal(read.alwaysOutputData, true, read.name);
  }
});

test('executes required shared reads once while preserving reconciliation loop limits', () => {
  const executeOnceReads = workflow.nodes
    .filter(({ type, executeOnce }) => type === 'n8n-nodes-base.dataTable' && executeOnce)
    .map(({ name }) => name)
    .sort();
  assert.deepEqual(executeOnceReads, [
    'Read Summary Request Rows',
    'Re-read Frozen Conflict',
    'Re-read Post-claim Frozen Conflict',
  ].sort());
  const limits = workflow.nodes
    .filter(({ type }) => type === 'n8n-nodes-base.limit')
    .map(({ name }) => name)
    .sort();
  assert.deepEqual(limits, [
    'Limit Initial Reconciliation',
    'Limit Reconciled Context',
    'Limit Side Effect Context',
    'Limit Side Effect Reconciliation',
  ].sort());
});

test('claims exact canonical completed pending row then verifies the returned owner row', () => {
  const claim = node('Claim Presentation');
  const map = filters('Claim Presentation');
  for (const key of ['id', 'attemptKey', 'status', 'reconciliationStatus', 'canonicalRowID', 'presentationStatus', 'presentationAttempt']) assert.ok(map[key], key);
  assert.equal(map.status.keyValue, 'completed');
  assert.equal(map.reconciliationStatus.keyValue, 'canonical');
  assert.equal(map.presentationStatus.keyValue, 'pending');
  assert.equal(claim.parameters.columns.value.presentationStatus, 'presenting');
  assert.equal(claim.parameters.columns.value.presentationLeaseOwner, '={{ $execution.id }}');
  assert.equal(claim.alwaysOutputData, true);
  assert.deepEqual(targets('Claim Presentation'), ['Verify Presentation Claim']);
});

test('keeps production system IDs numeric and canonical references string across every Data Table filter', () => {
  const plan = state.planCanonicalReconciliation([
    row({ id: 2, reconciliationStatus: 'pending', canonicalRowID: '' }),
    row({ id: 1, reconciliationStatus: 'pending', canonicalRowID: '' }),
  ]);
  assert.deepEqual(plan.mutations.map(({ id, desiredCanonicalRowID }) => [id, desiredCanonicalRowID]), [[2, '1'], [1, '1']]);
  assert.throws(() => state.planCanonicalReconciliation([row({ id: '1', canonicalRowID: '1' })]), /system field: id/);
  assert.throws(() => reconciliation.planCanonicalReconciliation([row({ id: '1', canonicalRowID: '1' })]), /Invalid same-attempt rows/);

  for (const table of workflow.nodes.filter(({ type, parameters }) => (
    type === 'n8n-nodes-base.dataTable' && parameters.filters?.conditions
  ))) {
    for (const condition of table.parameters.filters.conditions) {
      if (condition.keyName === 'id') assert.doesNotMatch(condition.keyValue, /String\(/, table.name);
      if (condition.keyName === 'canonicalRowID') assert.match(condition.keyValue, /String\(/, table.name);
    }
  }
  const guardSource = fs.readFileSync(path.join(workflowDir, 'nodes', 'Guard_Side_Effect', 'jsCode.js'), 'utf8');
  assert.match(guardSource, /expectedCanonicalRowID: String\(row\.id\)/);
  assert.match(guardSource, /desiredCanonicalRowID: String\(winner\.id\)/);
});

test('requires full reconciliation owner guard before every Slack side effect', () => {
  assert.deepEqual(targets('Verify Presentation Claim'), ['Read Before Side Effect']);
  assert.deepEqual(targets('Read Before Side Effect'), ['Limit Side Effect Context']);
  assert.deepEqual(targets('Limit Side Effect Context'), ['Read Summary Before Side Effect']);
  assert.deepEqual(targets('Read Summary Before Side Effect'), ['Guard Side Effect Owner']);
  assert.deepEqual(targets('Needs Side Effect Reconciliation', 1), ['Dispatch Presentation Stage']);
  for (const slack of ['Upload Transcript File', 'Upload Analysis File', 'Update Processing Message']) {
    const predecessors = workflow.nodes.filter(({ name }) => (
      (workflow.connections[name]?.main || []).some((output) => (output || []).some(({ node: target }) => target === slack))
    )).map(({ name }) => name);
    assert.ok(predecessors.length > 0, slack);
    assert.ok(reachable('Guard Side Effect Owner').has(slack), slack);
  }
});

test('routes every fallible node by phase without recursive failure handling', () => {
  const preClaim = [
    'Validate Input', 'Read All Attempt Rows', 'Read Summary Request Rows', 'Plan Canonical Reconciliation',
    'Apply Initial Reconciliation', 'Re-read After Reconciliation', 'Read Summary Rows After Reconciliation',
    'Freeze Canonical Conflict', 'Re-read Frozen Conflict', 'Verify Full Freeze', 'Read Eligible State',
    'Require Eligible Canonical', 'Claim Presentation',
  ];
  const postClaim = [
    'Verify Presentation Claim', 'Read Before Side Effect',
    'Read Summary Before Side Effect', 'Guard Side Effect Owner', 'Apply Side Effect Reconciliation',
    'Post-claim Freeze Canonical Conflict', 'Re-read Post-claim Frozen Conflict', 'Verify Post-claim Full Freeze',
    'Translate Dialogue', 'Prepare Transcript File', 'Upload Transcript File',
    'Extract Transcript Upload ID', 'Analyze Dialogue', 'Prepare Analysis File',
    'Upload Analysis File', 'Extract Analysis Upload ID', 'Update Processing Message', 'Prepare Message Checkpoint',
    'Checkpoint Transcript Upload', 'Checkpoint Analysis Upload', 'Checkpoint Processing Message',
    'Verify Transcript Checkpoint',
    'Verify Analysis Checkpoint',
    'Verify Message Checkpoint',
    'Complete Presentation', 'Verify Completion',
    'Prepare Completion Snapshot',
  ];
  const failureTerminal = [
    'Read Failure Attempt Rows', 'Plan Presentation Failure',
    'Patch Presentation Failure', 'Verify Failure State',
  ];
  const intentionalTerminal = ['Write Masked Presentation Audit', 'Write Masked Terminal Audit'];
  const fallibleTypes = new Set([
    'n8n-nodes-base.code', 'n8n-nodes-base.dataTable', 'n8n-nodes-base.slack',
    '@n8n/n8n-nodes-langchain.googleGemini',
  ]);
  const classified = [...preClaim, ...postClaim, ...failureTerminal, ...intentionalTerminal].sort();
  const actual = workflow.nodes.filter(({ type }) => fallibleTypes.has(type)).map(({ name }) => name).sort();
  assert.deepEqual(classified, actual);
  for (const name of preClaim) {
    assert.equal(node(name).onError, 'stopWorkflow', name);
    assert.deepEqual(targets(name, 1), [], name);
  }
  for (const name of postClaim) {
    assert.equal(node(name).onError, 'continueErrorOutput', name);
    assert.deepEqual(targets(name, 1), [POSTCLAIM_FAILURE_SOURCE[name]], name);
  }
  for (const name of failureTerminal) {
    assert.equal(node(name).onError, 'continueErrorOutput', name);
    assert.deepEqual(targets(name, 1), ['Write Masked Terminal Audit'], name);
  }
  for (const name of intentionalTerminal) assert.equal(node(name).onError, 'continueRegularOutput', name);
});

test('preserves canonical permanence and clean conflict convergence', () => {
  const later = row({ id: 26, createdAt: '2026-08-22T00:01:00.000Z', reconciliationStatus: 'pending', canonicalRowID: '' });
  const permanent = reconciliation.planCanonicalReconciliation([row(), later]);
  assert.equal(permanent.action, 'reconcile');
  assert.equal(permanent.mutations[0].desiredCanonicalRowID, '1');

  const clean = reconciliation.planCanonicalReconciliation([
    row({ id: 2, canonicalRowID: '2', dialogue: '', submittedAtIso: '', status: 'queued' }),
    row({ id: 1, canonicalRowID: '1', dialogue: '', submittedAtIso: '', status: 'queued' }),
  ]);
  assert.equal(clean.action, 'reconcile');
  assert.equal(clean.mutations[0].id, 2);
  assert.equal(clean.mutations[0].desiredCanonicalRowID, '1');
  assert.equal(clean.mutations[0].expectedStatus, 'queued');
  for (const name of ['Apply Initial Reconciliation', 'Apply Side Effect Reconciliation']) {
    assert.equal(filters(name).status.keyValue, '={{ $json.expectedStatus }}', name);
    assert.equal(node(name).parameters.matchType, 'allConditions', name);
  }
  for (const status of ['', ' ', null, 1]) {
    assert.throws(() => reconciliation.planCanonicalReconciliation([row({ status })]), /status/);
  }
});

test('freezes all competing canonicals with any attempt or Summary checkpoint and reaches zero Slack', () => {
  for (const fixture of [
    [row({ id: 1, canonicalRowID: '1' }), row({ id: 2, canonicalRowID: '2' })],
    [row({ id: 1, canonicalRowID: '1', dialogue: '' }), row({ id: 2, canonicalRowID: '2', dialogue: '' })],
  ]) {
    const plan = reconciliation.planCanonicalReconciliation(fixture, fixture[0].dialogue ? [] : [{ requestKey: 'summary:req-001', summaryUploadID: 'F-SUMMARY' }]);
    assert.equal(plan.action, 'manual_review');
    assert.equal(plan.mutations.length, 2);
  }
  const reachableFromFreeze = reachable('Freeze Conflict Plan');
  for (const slack of ['Upload Transcript File', 'Upload Analysis File', 'Update Processing Message']) assert.equal(reachableFromFreeze.has(slack), false);
  assert.deepEqual(targets('Re-read Frozen Conflict'), ['Verify Full Freeze']);
  const frozen = (fixture, overrides = {}) => row({
    id: fixture, canonicalRowID: String(fixture), status: 'manual_review',
    manualReviewReason: 'multiple_canonical_checkpoint_conflict', manualReviewAtIso: NOW,
    presentationLeaseOwner: '', presentationLeaseUntilIso: '',
    ...overrides,
  });
  assert.deepEqual(state.verifyFrozenConflict([frozen(1), frozen(2)], [1, 2]).map(({ id }) => id), [1, 2]);
  assert.throws(() => state.verifyFrozenConflict([frozen(1)], [1, 2]), /incomplete/);
  assert.throws(() => state.verifyFrozenConflict([frozen(1), frozen(3)], [1, 2]), /identity/);
  assert.throws(() => state.verifyFrozenConflict([frozen(1), frozen(2, { presentationLeaseOwner: 'exec-1' })], [1, 2]));
});

test('skips persisted checkpoints and recovers in strict stage order', () => {
  assert.equal(state.selectNextStage(row()), 'transcript');
  assert.equal(state.selectNextStage(row({ transcriptUploadID: 'F1' })), 'analysis');
  assert.equal(state.selectNextStage(row({ transcriptUploadID: 'F1', analysisUploadID: 'F2' })), 'message_update');
  assert.equal(state.selectNextStage(row({ transcriptUploadID: 'F1', analysisUploadID: 'F2', processingMessageUpdatedAtIso: NOW })), 'complete');
  for (const name of ['Verify Transcript Checkpoint', 'Verify Analysis Checkpoint', 'Verify Message Checkpoint']) {
    assert.deepEqual(targets(name), ['Continue Presentation']);
  }
  assert.equal(node('Continue Presentation').type, 'n8n-nodes-base.noOp');
  assert.equal(node('Continue Presentation').typeVersion, 1);
  assert.deepEqual(targets('Continue Presentation'), ['Read Before Side Effect']);
  const guardEntrances = workflow.nodes.filter(({ name }) => targets(name).includes('Read Before Side Effect')).map(({ name }) => name).sort();
  assert.deepEqual(guardEntrances, ['Continue Presentation', 'Limit Side Effect Reconciliation', 'Verify Presentation Claim'].sort());
});

test('uses one fail-closed switch only after the persisted owner guard', () => {
  const router = node('Dispatch Presentation Stage');
  assert.equal(router.type, 'n8n-nodes-base.switch');
  assert.equal(router.typeVersion, 3.4);
  assert.deepEqual(router.parameters.rules.values.map(({ outputKey }) => outputKey), [
    'transcript', 'analysis', 'message_update', 'complete',
  ]);
  assert.equal(router.parameters.options.fallbackOutput, 'extra');
  assert.deepEqual(targets('Dispatch Presentation Stage', 0), ['Transcript Is zh']);
  assert.deepEqual(targets('Dispatch Presentation Stage', 1), ['Analyze Dialogue']);
  assert.deepEqual(targets('Dispatch Presentation Stage', 2), ['Update Processing Message']);
  assert.deepEqual(targets('Dispatch Presentation Stage', 3), ['Prepare Completion Snapshot']);
  assert.deepEqual(targets('Dispatch Presentation Stage', 4), ['Failure Source Side Effect Guard']);
});

test('separates claim verification from persisted stage selection', () => {
  const claimSource = fs.readFileSync(path.join(workflowDir, 'nodes', 'Require_Claim_Owner', 'jsCode.js'), 'utf8');
  assert.match(claimSource, /presentation_claim_verified/);
  assert.doesNotMatch(claimSource, /presentationStage|dispatchRoute/);

  const guardSource = fs.readFileSync(path.join(workflowDir, 'nodes', 'Guard_Side_Effect', 'jsCode.js'), 'utf8');
  assert.match(guardSource, /: 'complete'/);
  assert.doesNotMatch(guardSource, /No side effect remains/);
});

test('requires the exact unexpired owner and fails closed on conflicts or zero-CAS state', () => {
  const presenting = row({
    presentationStatus: 'presenting', presentationLeaseOwner: 'exec-1',
    presentationLeaseUntilIso: '2026-08-22T00:05:00.000Z', presentationAttempt: 1,
  });
  assert.equal(state.requireCanonicalOwner([presenting], 'exec-1', NOW).id, 1);
  assert.throws(() => state.requireCanonicalOwner([presenting], 'exec-2', NOW), /owner mismatch/);
  assert.throws(() => state.requireCanonicalOwner([presenting], 'exec-1', '2026-08-22T00:05:00.000Z'), /expired/);
  assert.throws(() => state.requireCanonicalOwner([
    presenting,
    row({ id: 2, canonicalRowID: '2', presentationStatus: 'presenting', presentationLeaseOwner: 'exec-1', presentationLeaseUntilIso: '2026-08-22T00:05:00.000Z' }),
  ], 'exec-1', NOW), /exactly one/);
  assert.throws(() => state.verifyTerminalPresentation([presenting], {
    id: 1, presentationStatus: 'retry_pending', presentationAttempt: 1,
    presentationNextRetryAtIso: '2026-08-22T00:01:00.000Z', presentationErrorCode: 'x',
  }), /mismatch/);
});

test('parses the pinned n8n 1.123.27 Slack 2.3 expanded upload item only', () => {
  assert.equal(state.extractSlackUploadID(PINNED_SLACK_2_3_UPLOAD_ITEMS), 'F08ABC123');
  for (const items of [
    [],
    [{ json: {} }],
    [{ json: { id: 'F1' } }, { json: { id: 'F2' } }],
    [{ json: { error: 'upload_failed', id: 'F1' } }],
    [{ json: { ok: false, id: 'F1' } }],
    [{ json: { id: '171234.0001', ts: '171234.0001' } }],
    [{ json: { id: 'M08ABC123', text: 'message' } }],
    [{ json: { ok: true, file: { id: 'F1' } } }],
  ]) assert.throws(() => state.extractSlackUploadID(items));
  const source = fs.readFileSync(path.join(workflowDir, 'nodes', 'Extract_Upload_ID', 'jsCode.js'), 'utf8');
  assert.match(source, /\$input\.all\(\)/);
  assert.doesNotMatch(source, /response\.file|response\.files|response\.ok/);
  assert.match(source, /Guard Side Effect Owner/);
});

test('verifies the exact checkpoint value and full claim provenance', () => {
  const expected = row({
    presentationStatus: 'presenting', presentationLeaseOwner: 'exec-1',
    presentationLeaseUntilIso: '2026-08-22T00:05:00.000Z', presentationAttempt: 1,
    transcriptUploadID: 'F1', checkpointField: 'transcriptUploadID', checkpointValue: 'F1',
  });
  assert.equal(state.verifyExactCheckpoint([expected], expected).transcriptUploadID, 'F1');
  for (const changed of [
    { id: 2, canonicalRowID: '2' }, { attemptKey: 'summary:req-001:current:9001:fromStart:2' },
    { status: 'manual_review' }, { presentationStatus: 'pending' }, { presentationLeaseOwner: 'exec-2' },
    { presentationLeaseUntilIso: '2026-08-22T00:06:00.000Z' }, { presentationAttempt: 2 },
    { transcriptUploadID: 'F2' },
  ]) assert.throws(() => state.verifyExactCheckpoint([{ ...expected, ...changed }], expected));
});

test('persists and verifies the same generated message checkpoint value', () => {
  assert.deepEqual(targets('Update Processing Message'), ['Prepare Message Checkpoint']);
  assert.deepEqual(targets('Prepare Message Checkpoint'), ['Checkpoint Processing Message']);
  const values = node('Checkpoint Processing Message').parameters.columns.value;
  assert.equal(values.processingMessageUpdatedAtIso, "={{ $('Prepare Message Checkpoint').first().json.checkpointValue }}");
  assert.equal(values.updatedAtIso, "={{ $('Prepare Message Checkpoint').first().json.checkpointValue }}");
});

test('verifies completion against the original claim and exact checkpoint snapshot', () => {
  const claim = row({
    presentationStatus: 'presenting', presentationLeaseOwner: 'exec-1',
    presentationLeaseUntilIso: '2026-08-22T00:05:00.000Z', presentationAttempt: 1,
    streamContextJson: '{"source":"fixture"}',
  });
  const checkpoint = {
    ...claim, transcriptUploadID: 'F1', analysisUploadID: 'F2', processingMessageUpdatedAtIso: NOW,
  };
  const expectation = state.buildCompletionExpectation(claim, checkpoint);
  const completed = {
    ...checkpoint, presentationStatus: 'completed', presentationLeaseOwner: '', presentationLeaseUntilIso: '',
  };
  assert.equal(state.verifyCompletion([completed], expectation).id, 1);
  assert.deepEqual(targets('Dispatch Presentation Stage', 3), ['Prepare Completion Snapshot']);
  assert.deepEqual(targets('Prepare Completion Snapshot'), ['Complete Presentation']);

  assert.throws(() => state.verifyCompletion([], expectation), /not found/);
  assert.throws(() => state.verifyCompletion([
    completed,
    { ...completed, id: 2, canonicalRowID: '2' },
  ], expectation), /exactly one/);
  assert.throws(() => state.verifyCompletion([
    { ...completed, id: 2, canonicalRowID: '2' },
  ], expectation), /mismatch/);

  for (const field of ['id', 'attemptKey', 'attempt', 'presentationAttempt', ...state.COMPLETION_PROVENANCE_FIELDS]) {
    const value = completed[field];
    const changed = typeof value === 'number' ? value + 1 : `${value}-drift`;
    const candidate = { ...completed, [field]: changed };
    if (field === 'id') candidate.canonicalRowID = String(changed);
    assert.throws(() => state.verifyCompletion([candidate], expectation), field);
  }
  for (const field of state.PRESENTATION_CHECKPOINT_FIELDS) {
    assert.throws(() => state.verifyCompletion([{ ...completed, [field]: `${completed[field]}-drift` }], expectation), field);
  }
  assert.throws(() => state.verifyCompletion([{ ...completed, presentationStatus: 'presenting' }], expectation));
  assert.throws(() => state.verifyCompletion([{ ...completed, presentationLeaseOwner: 'exec-1' }], expectation));
});

test('uses explicit sanitized graph constants before the common failure read', () => {
  for (const [name, expected] of Object.entries(FAILURE_CATEGORIES)) {
    const constant = node(name);
    assert.equal(constant.type, 'n8n-nodes-base.set', name);
    assert.equal(constant.parameters.includeOtherFields, false, name);
    assert.deepEqual(constant.parameters.assignments.assignments.map(({ name: field }) => field), [
      'failureSource', 'errorCode', 'potentialDuplicateUpload',
    ], name);
    const values = Object.fromEntries(constant.parameters.assignments.assignments.map(({ name: field, value }) => [field, value]));
    assert.deepEqual(values, {
      failureSource: expected.failureSource,
      errorCode: expected.errorCode,
      potentialDuplicateUpload: expected.potentialDuplicateUpload,
    }, name);
    assert.deepEqual(targets(name), ['Failure Context'], name);
  }
  assert.deepEqual(targets('Failure Context'), ['Read Failure Attempt Rows']);
  assert.deepEqual(targets('Read Failure Attempt Rows'), ['Plan Presentation Failure']);
  assert.equal(workflow.nodes.some(({ name }) => name === 'Capture Presentation Error Context'), false);
  assert.equal(fs.existsSync(path.join(workflowDir, 'nodes', 'Capture_Error_Context', 'jsCode.js')), false);
  assert.doesNotMatch(JSON.stringify(workflow), /Capture Presentation Error Context/);
  const source = fs.readFileSync(path.join(workflowDir, 'nodes', 'Plan_Failure', 'jsCode.js'), 'utf8');
  assert.match(source, /Failure Context/);
  assert.match(source, /Claim Presentation/);
  assert.doesNotMatch(source, /isExecuted|selectNextStage|persistedStage|Capture Presentation Error Context/);
});

test('failure owner verification uses latest persisted checkpoints and fails closed', () => {
  const claim = row({
    presentationStatus: 'presenting', presentationLeaseOwner: 'exec-1',
    presentationLeaseUntilIso: '2026-08-22T00:05:00.000Z', presentationAttempt: 1,
  });
  const transcriptSaved = { ...claim, transcriptUploadID: 'F08TRANSCRIPT' };
  const claimFailure = state.verifyFailureOwnerSnapshot(
    [transcriptSaved], claim,
    { failureSource: 'claim_owner', errorCode: 'presentation_claim_owner_failed', potentialDuplicateUpload: false },
    'exec-1', NOW,
  );
  assert.equal(claimFailure.failureSource, 'claim_owner');
  assert.equal(claimFailure.transcriptUploadID, 'F08TRANSCRIPT');

  const uploadsSaved = { ...transcriptSaved, analysisUploadID: 'F08ANALYSIS' };
  const messageFailure = state.verifyFailureOwnerSnapshot(
    [uploadsSaved], claim,
    { failureSource: 'message_update', errorCode: 'presentation_message_update_failed', potentialDuplicateUpload: false },
    'exec-1', NOW,
  );
  assert.equal(messageFailure.failureSource, 'message_update');
  const completionFailure = state.verifyFailureOwnerSnapshot(
    [{ ...uploadsSaved, processingMessageUpdatedAtIso: NOW }], claim,
    { failureSource: 'complete', errorCode: 'presentation_complete_failed', potentialDuplicateUpload: false }, 'exec-1', NOW,
  );
  assert.equal(completionFailure.failureSource, 'complete');

  const duplicateRisk = state.verifyFailureOwnerSnapshot(
    [transcriptSaved], claim,
    { failureSource: 'transcript_checkpoint', errorCode: 'potential_duplicate_upload', potentialDuplicateUpload: true },
    'exec-1', NOW,
  );
  assert.equal(duplicateRisk.failureSource, 'transcript_checkpoint');
  assert.equal(duplicateRisk.errorCode, 'potential_duplicate_upload');
  assert.equal(duplicateRisk.potentialDuplicateUpload, true);

  const invalidContext = { failureSource: 'analysis', errorCode: 'x', potentialDuplicateUpload: false };
  assert.throws(() => state.verifyFailureOwnerSnapshot([], claim, invalidContext, 'exec-1', NOW));
  assert.throws(() => state.verifyFailureOwnerSnapshot([
    claim,
    { ...claim, id: 2, canonicalRowID: '2' },
  ], claim, invalidContext, 'exec-1', NOW));
  assert.throws(() => state.verifyFailureOwnerSnapshot(
    [{ ...claim, presentationLeaseOwner: 'exec-2' }], claim,
    invalidContext, 'exec-1', NOW,
  ));
  assert.throws(() => state.verifyFailureOwnerSnapshot(
    [claim], claim,
    { failureSource: 'analysis', errorCode: 'presentation_analysis_failed', potentialDuplicateUpload: false },
    'exec-1', '2026-08-22T00:05:00.000Z',
  ));
  for (const changed of [{ dialogue: 'drift' }, { language: 'zh' }]) {
    assert.throws(() => state.verifyFailureOwnerSnapshot(
      [{ ...claim, ...changed }], claim,
      { failureSource: 'analysis', errorCode: 'presentation_analysis_failed', potentialDuplicateUpload: false }, 'exec-1', NOW,
    ));
  }
});

test('post-claim business errors cannot reach the planner directly', () => {
  const planner = 'Plan Presentation Failure';
  const convergence = 'Failure Context';
  const failurePath = new Set([
    ...Object.keys(FAILURE_CATEGORIES), convergence, 'Read Failure Attempt Rows', planner,
    'Patch Presentation Failure', 'Verify Failure State',
    'Write Masked Presentation Audit', 'Write Masked Terminal Audit',
  ]);
  for (const candidate of workflow.nodes) {
    if (failurePath.has(candidate.name)) continue;
    assert.equal(targets(candidate.name, 1).includes(planner), false, candidate.name);
  }
  assert.equal(reachable(convergence).has(planner), true);
});

test('records the upload-success checkpoint-write crash as a residual duplicate risk', () => {
  assert.equal(state.checkpointCrashCode('transcript', true), 'potential_duplicate_upload');
  assert.equal(state.checkpointCrashCode('analysis', true), 'potential_duplicate_upload');
  assert.notEqual(state.checkpointCrashCode('transcript', false), 'potential_duplicate_upload');
  assert.match(workflow.description, /potential_duplicate_upload/);
  assert.doesNotMatch(workflow.description, /idempotent|exactly-once/i);
});

test('builds deterministic sanitized transcript binary with canonical return shape', () => {
  const result = transcript.buildTranscriptFile(row({ attemptKey: 'bad/key with spaces', translatedDialogue: '哈囉' }));
  assert.ok(result.binary.stt_data);
  assert.match(result.binary.stt_data.fileName, /^stt_result_bad_key_with_spaces_9001_fromStart\.txt$/);
  assert.doesNotMatch(result.binary.stt_data.fileName, /\d{13}/);
  const text = Buffer.from(result.binary.stt_data.data, 'base64').toString('utf8');
  assert.match(text, /繁體中文翻譯/);
  assert.match(text, /hello world/);
});

test('uses dialogue directly for zh and requires Gemini translation otherwise', () => {
  const zh = transcript.buildTranscriptFile(row({ language: 'zh', dialogue: '原文' }));
  const text = Buffer.from(zh.binary.stt_data.data, 'base64').toString('utf8');
  assert.doesNotMatch(text, /繁體中文翻譯/);
  assert.match(text, /原文/);
  assert.throws(() => transcript.buildTranscriptFile(row({ language: 'en' })), /Translation is empty/);
});

test('rejects empty or malformed AI analysis and preserves report formatting', () => {
  assert.throws(() => analysisFormat.parseAnalysisResponse({}), /empty/);
  assert.throws(() => analysisFormat.parseAnalysisResponse({ content: { parts: [{ text: 'not-json' }] } }), /malformed/);
  const parsed = analysisFormat.parseAnalysisResponse({ content: { parts: [{ text: '```json\n[{"issue":"lag","ref":"畫面卡住"}]\n```' }] } });
  const formatted = analysisFormat.formatAnalysis(parsed);
  assert.match(formatted, /\[問題 1\]/);
  assert.match(formatted, /描述: lag/);
  const file = analysis.buildAnalysisFile({ ...row(), formattedAnalysisText: formatted });
  assert.ok(file.binary.analysis_data);
  assert.match(file.binary.analysis_data.fileName, /^stt_analysis_/);
  assert.equal(analysisFormat.formatAnalysis([]), '');
  assert.ok(analysis.buildAnalysisFile({ ...row(), formattedAnalysisText: '' }).binary.analysis_data);
});

test('uses exact binary keys through downstream Slack nodes', () => {
  assert.equal(node('Upload Transcript File').parameters.binaryPropertyName, 'stt_data');
  assert.equal(node('Upload Analysis File').parameters.binaryPropertyName, 'analysis_data');
  assert.equal(node('Prepare Transcript File').parameters.mode, 'runOnceForAllItems');
  assert.equal(node('Prepare Analysis File').parameters.mode, 'runOnceForAllItems');
  assert.deepEqual(targets('Prepare Transcript File'), ['Upload Transcript File']);
  assert.deepEqual(targets('Prepare Analysis File'), ['Upload Analysis File']);
});

test('uses deterministic persisted C0 routing and final text with no C09', () => {
  const serialized = JSON.stringify(workflow);
  assert.match(serialized, /C0A4JJJKJMD/);
  assert.doesNotMatch(serialized, /C09F0SYG57D/);
  for (const slack of workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.slack')) {
    assert.equal(slack.credentials.slackApi.name, 'n8n-streaming-testing', slack.name);
    assert.equal(slack.onError, 'continueErrorOutput', slack.name);
    assert.deepEqual(targets(slack.name, 1), [POSTCLAIM_FAILURE_SOURCE[slack.name]], slack.name);
  }
  assert.equal(state.buildFinalText(row()), '🤖 STT Done\nStream: `9001`\nMode: `fromStart` 5m');
  assert.equal(fs.readFileSync(path.join(workflowDir, 'nodes', 'Update_Processing_Msg', 'text.md'), 'utf8').trim(), "=🤖 STT Done\nStream: `{{ $('Guard Side Effect Owner').first().json.streamID }}`\nMode: `{{ $('Guard Side Effect Owner').first().json.mode }}` {{ $('Guard Side Effect Owner').first().json.durationMinutes }}m");
});

test('implements failure attempts 1m, 5m, then terminal failed with only presentation fields', () => {
  const first = state.planPresentationFailure({ presentationAttempt: 1 }, NOW, 'x');
  assert.equal(first.presentationStatus, 'retry_pending');
  assert.equal(first.presentationNextRetryAtIso, '2026-08-22T00:01:00.000Z');
  const second = state.planPresentationFailure({ presentationAttempt: 2 }, NOW, 'x');
  assert.equal(second.presentationNextRetryAtIso, '2026-08-22T00:05:00.000Z');
  const third = state.planPresentationFailure({ presentationAttempt: 3 }, NOW, 'x');
  assert.equal(third.presentationStatus, 'failed');
  assert.equal(third.presentationNextRetryAtIso, '');
  const allowed = new Set(state.PRESENTATION_MUTATION_FIELDS);
  assert.ok(Object.keys(first).every((key) => allowed.has(key)));
});

test('uses exact owner/checkpoint CAS and verifies every returned presentation write row', () => {
  for (const name of ['Checkpoint Transcript Upload', 'Checkpoint Analysis Upload', 'Checkpoint Processing Message', 'Complete Presentation', 'Patch Presentation Failure']) {
    const map = filters(name);
    for (const key of ['id', 'attemptKey', 'status', 'reconciliationStatus', 'canonicalRowID', 'presentationStatus', 'presentationLeaseOwner', 'presentationLeaseUntilIso', 'presentationAttempt']) assert.ok(map[key], `${name}: ${key}`);
    assert.equal(node(name).parameters.matchType, 'allConditions', name);
    assert.equal(node(name).alwaysOutputData, true, name);
  }
  const writeToVerifier = {
    'Checkpoint Transcript Upload': 'Verify Transcript Checkpoint',
    'Checkpoint Analysis Upload': 'Verify Analysis Checkpoint',
    'Checkpoint Processing Message': 'Verify Message Checkpoint',
    'Complete Presentation': 'Verify Completion',
    'Patch Presentation Failure': 'Verify Failure State',
  };
  for (const [write, verifier] of Object.entries(writeToVerifier)) {
    assert.deepEqual(targets(write), [verifier], write);
  }
  for (const name of ['Re-read Presentation Claim', 'Re-read Transcript Checkpoint', 'Re-read Analysis Checkpoint', 'Re-read Message Checkpoint', 'Re-read Completion', 'Re-read Failure State']) {
    assert.equal(workflow.nodes.some((candidate) => candidate.name === name), false, name);
  }
  for (const name of ['Checkpoint Transcript Upload', 'Checkpoint Analysis Upload', 'Checkpoint Processing Message']) {
    assert.deepEqual(targets(name, 1), [POSTCLAIM_FAILURE_SOURCE[name]], `${name} error output`);
  }
  const failureRead = node('Read Failure Attempt Rows');
  assert.equal(failureRead.parameters.returnAll, true);
  assert.equal(failureRead.alwaysOutputData, true);
  assert.deepEqual(targets('Read Failure Attempt Rows', 1), ['Write Masked Terminal Audit']);
  const failureFilters = filters('Patch Presentation Failure');
  for (const key of [
    'id', 'attemptKey', 'status', 'reconciliationStatus', 'canonicalRowID', 'presentationStatus',
    'presentationLeaseOwner', 'presentationLeaseUntilIso', 'presentationAttempt',
    'transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso',
  ]) assert.ok(failureFilters[key], key);
  assert.equal(failureFilters.id.keyValue, '={{ $json.id }}');
  assert.equal(failureFilters.attemptKey.keyValue, '={{ $json.attemptKey }}');
  assert.equal(failureFilters.status.keyValue, 'completed');
  assert.equal(failureFilters.reconciliationStatus.keyValue, 'canonical');
  assert.equal(failureFilters.canonicalRowID.keyValue, '={{ String($json.id) }}');
  assert.equal(failureFilters.presentationStatus.keyValue, 'presenting');
  assert.equal(failureFilters.presentationLeaseOwner.keyValue, '={{ $execution.id }}');
  assert.equal(failureFilters.presentationLeaseUntilIso.keyValue, '={{ $json.presentationLeaseUntilIso }}');
  assert.equal(failureFilters.presentationAttempt.keyValue, '={{ $json.presentationAttempt }}');
  assert.equal(failureFilters.transcriptUploadID.keyValue, "={{ $json.transcriptUploadID || '' }}");
  assert.equal(failureFilters.analysisUploadID.keyValue, "={{ $json.analysisUploadID || '' }}");
  assert.equal(failureFilters.processingMessageUpdatedAtIso.keyValue, "={{ $json.processingMessageUpdatedAtIso || '' }}");
});

test('persists masked audit evidence without transcript, token, or upstream content', () => {
  const audit = node('Write Masked Presentation Audit');
  assert.equal(audit.parameters.dataTableId.value, 'automation_errors_v3');
  const values = audit.parameters.columns.value;
  assert.deepEqual(Object.keys(values), ['errorKey', 'component', 'reconciliationStatus', 'canonicalRowID', 'requestKey', 'logicalJobKey', 'attemptKey', 'executionID', 'workflowName', 'nodeName', 'errorCode', 'messageMasked', 'retryable', 'createdAtIso']);
  const serialized = JSON.stringify(values);
  assert.doesNotMatch(serialized, /dialogue|transcription|callbackToken|content\.parts|response/i);
});

test('has no callback body, Webhook references, raw token, STT core writer, or new attempt writer', () => {
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /\$json\.body|\$node\["Webhook"\]|callbackTokenHash|consumedAtIso.*columns|operation":"insert".*stt_jobs_v3/);
  assert.equal(workflow.nodes.some(({ name }) => /Webhook|Callback/.test(name)), false);
  const presentationWrites = ['Claim Presentation', 'Checkpoint Transcript Upload', 'Checkpoint Analysis Upload', 'Checkpoint Processing Message', 'Complete Presentation', 'Patch Presentation Failure'];
  for (const name of presentationWrites) assert.equal('status' in node(name).parameters.columns.value, false, name);
});

test('uses approved execution retention and unique UUIDv4 node IDs', () => {
  assert.deepEqual(workflow.settings, {
    executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all',
    saveManualExecutions: true, saveExecutionProgress: false,
  });
  const ids = workflow.nodes.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
