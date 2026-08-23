const assert = require('node:assert/strict');
const test = require('node:test');

const schema = require('../nodes/State_Schema/schema.json');
const {
  CONTRACT,
  orderedStreams,
  reconcileRows,
  resolveCanonicalConflict,
} = require('./fixtures');

const EXPECTED_TABLES = [
  'suspect_stt_candidates_v3',
  'stt_jobs_v3',
  'summary_requests_v3',
  'automation_errors_v3',
];

test('defines only the four isolated v3 tables', () => {
  assert.deepEqual(Object.keys(schema), EXPECTED_TABLES);
  assert.ok(Object.keys(schema).every((name) => name.endsWith('_v3')));
});

test('uses primitive custom columns without system column collisions', () => {
  const forbidden = new Set(['id', 'createdAt', 'updatedAt']);
  const primitiveTypes = new Set(['string', 'number', 'boolean']);

  for (const columns of Object.values(schema)) {
    assert.ok(columns.length > 0);
    assert.ok(columns.every(({ name, type }) => !forbidden.has(name) && primitiveTypes.has(type)));
    assert.equal(new Set(columns.map(({ name }) => name)).size, columns.length);
  }
});

test('keeps canonical internal names and adapter aliases at the boundary', () => {
  assert.deepEqual(CONTRACT.modes, ['fromStart', 'fromEnd']);
  assert.deepEqual(CONTRACT.identities, ['requestKey', 'logicalJobKey', 'attemptKey']);
  assert.equal(CONTRACT.channel, 'channel');
  assert.deepEqual(CONTRACT.adapterAliases, {
    modes: { first: 'fromStart', last: 'fromEnd' },
    identities: { candidateKey: 'requestKey', jobKey: 'logicalJobKey' },
    channels: { channelID: 'channel', channelId: 'channel' },
  });
});

test('does not expose legacy aliases as internal schema fields', () => {
  for (const [tableName, columns] of Object.entries(schema)) {
    const names = columns.map(({ name }) => name);
    assert.ok(!names.includes('jobKey'));
    assert.ok(!names.includes('channelID'));
    assert.ok(!names.includes('channelId'));
    assert.equal(names.includes('candidateKey'), tableName === 'suspect_stt_candidates_v3');
  }
});

test('locks attempt, request, reconciliation, and manual review stage enums', () => {
  assert.deepEqual(CONTRACT.attemptStatuses, [
    'queued',
    'dispatching',
    'waiting_callback',
    'completed',
    'retry_pending',
    'retry_materializing',
    'retry_materialized',
    'failed',
    'timed_out',
    'manual_review',
  ]);
  assert.deepEqual(CONTRACT.requestStatuses, [
    'creating',
    'ready',
    'waiting_stt',
    'summary_dispatching',
    'summary_retry_pending',
    'manual_review',
    'completed',
    'failed',
    'creation_failed',
  ]);
  assert.deepEqual(CONTRACT.reconciliationStatuses, ['pending', 'canonical', 'duplicate']);
  assert.deepEqual(CONTRACT.manualReviewOriginalStages, [
    'ready',
    'summary_dispatching',
    'summary_retry_pending',
    'completed',
  ]);
  assert.ok(!CONTRACT.requestStatuses.includes('duplicate'));
});

test('includes reconciliation fields on every deterministic-key table', () => {
  for (const columns of Object.values(schema)) {
    const names = columns.map(({ name }) => name);
    assert.ok(names.includes('reconciliationStatus'));
    assert.ok(names.includes('canonicalRowID'));
  }
});

test('keeps suspect candidates provenance-only and automation errors masked', () => {
  const candidateNames = schema.suspect_stt_candidates_v3.map(({ name }) => name);
  const errorNames = schema.automation_errors_v3.map(({ name }) => name);

  for (const forbidden of ['status', 'attemptKey', 'dialogue', 'summaryMarkdown', 'inferenceResultJson']) {
    assert.ok(!candidateNames.includes(forbidden));
  }
  for (const forbidden of ['callbackToken', 'callbackTokenHash', 'headers', 'body', 'responseBody']) {
    assert.ok(!errorNames.includes(forbidden));
  }
  assert.ok(errorNames.includes('messageMasked'));
});

test('defines the exact candidate provenance schema', () => {
  assert.deepEqual(schema.suspect_stt_candidates_v3, [
    { name: 'candidateKey', type: 'string' },
    { name: 'runID', type: 'string' },
    { name: 'streamID', type: 'string' },
    { name: 'prevStreamID', type: 'string' },
    { name: 'sourcesJson', type: 'string' },
    { name: 'channel', type: 'string' },
    { name: 'threadTS', type: 'string' },
    { name: 'summaryRequestKey', type: 'string' },
    { name: 'reconciliationStatus', type: 'string' },
    { name: 'canonicalRowID', type: 'string' },
    { name: 'createdAtIso', type: 'string' },
    { name: 'updatedAtIso', type: 'string' },
  ]);
});

test('defines the exact stt job schema required by the provisioning contract', () => {
  assert.deepEqual(schema.stt_jobs_v3, [
    { name: 'attemptKey', type: 'string' }, { name: 'logicalJobKey', type: 'string' },
    { name: 'requestKey', type: 'string' }, { name: 'requestType', type: 'string' },
    { name: 'attempt', type: 'number' }, { name: 'role', type: 'string' },
    { name: 'streamID', type: 'string' }, { name: 'mode', type: 'string' },
    { name: 'durationMinutes', type: 'number' }, { name: 'streamContextJson', type: 'string' },
    { name: 'status', type: 'string' }, { name: 'callbackTokenHash', type: 'string' },
    { name: 'reconciliationStatus', type: 'string' }, { name: 'canonicalRowID', type: 'string' },
    { name: 'dispatchLeaseOwner', type: 'string' }, { name: 'dispatchLeaseUntilIso', type: 'string' },
    { name: 'submittedAtIso', type: 'string' }, { name: 'callbackDeadlineAtIso', type: 'string' },
    { name: 'manualReviewReason', type: 'string' }, { name: 'manualReviewAtIso', type: 'string' },
    { name: 'manualReviewResolution', type: 'string' },
    { name: 'callbackTokenExpiresAtIso', type: 'string' }, { name: 'consumedAtIso', type: 'string' },
    { name: 'channel', type: 'string' }, { name: 'threadTS', type: 'string' },
    { name: 'processingMessageTS', type: 'string' }, { name: 'dialogue', type: 'string' },
    { name: 'language', type: 'string' }, { name: 'errorCode', type: 'string' },
    { name: 'nextRetryAtIso', type: 'string' }, { name: 'retryLeaseOwner', type: 'string' },
    { name: 'retryLeaseUntilIso', type: 'string' }, { name: 'duplicateCount', type: 'number' },
    { name: 'presentationStatus', type: 'string' }, { name: 'presentationLeaseOwner', type: 'string' },
    { name: 'presentationLeaseUntilIso', type: 'string' }, { name: 'presentationAttempt', type: 'number' },
    { name: 'presentationNextRetryAtIso', type: 'string' }, { name: 'presentationErrorCode', type: 'string' },
    { name: 'transcriptUploadID', type: 'string' }, { name: 'analysisUploadID', type: 'string' },
    { name: 'processingMessageUpdatedAtIso', type: 'string' }, { name: 'createdAtIso', type: 'string' },
    { name: 'updatedAtIso', type: 'string' },
  ]);
});

test('includes summary creation, resolution, lease, and checkpoint fields', () => {
  const names = schema.summary_requests_v3.map(({ name }) => name);
  const required = [
    'creationLeaseOwner',
    'creationLeaseUntilIso',
    'orderedStreamsJson',
    'expectedLogicalJobKeysJson',
    'leaseOwner',
    'leaseUntilIso',
    'inferenceResultJson',
    'summaryMarkdown',
    'summaryUploadID',
    'summaryMessageTS',
    'manualReviewReason',
    'manualReviewAtIso',
    'manualReviewResolution',
    'manualReviewOriginalStage',
    'manualResolutionWinnerRowID',
    'manualResolutionDecisionID',
  ];

  assert.ok(required.every((name) => names.includes(name)));
});

test('defines the exact summary request schema', () => {
  assert.deepEqual(schema.summary_requests_v3, [
    { name: 'requestKey', type: 'string' }, { name: 'requestType', type: 'string' },
    { name: 'status', type: 'string' }, { name: 'creationLeaseOwner', type: 'string' },
    { name: 'reconciliationStatus', type: 'string' }, { name: 'canonicalRowID', type: 'string' },
    { name: 'creationLeaseUntilIso', type: 'string' }, { name: 'orderedStreamsJson', type: 'string' },
    { name: 'existingDialoguesJson', type: 'string' }, { name: 'expectedLogicalJobKeysJson', type: 'string' },
    { name: 'channel', type: 'string' }, { name: 'threadTS', type: 'string' },
    { name: 'coverageStatus', type: 'string' }, { name: 'availableRolesJson', type: 'string' },
    { name: 'missingRolesJson', type: 'string' }, { name: 'failedLogicalJobKeysJson', type: 'string' },
    { name: 'leaseOwner', type: 'string' }, { name: 'leaseUntilIso', type: 'string' },
    { name: 'summaryAttempt', type: 'number' }, { name: 'nextRetryAtIso', type: 'string' },
    { name: 'errorCode', type: 'string' }, { name: 'inferenceResultJson', type: 'string' },
    { name: 'summaryMarkdown', type: 'string' },
    { name: 'summaryMessageTS', type: 'string' }, { name: 'summaryUploadID', type: 'string' },
    { name: 'manualReviewReason', type: 'string' }, { name: 'manualReviewAtIso', type: 'string' },
    { name: 'manualReviewResolution', type: 'string' },
    { name: 'manualReviewOriginalStage', type: 'string' },
    { name: 'manualResolutionWinnerRowID', type: 'string' },
    { name: 'manualResolutionDecisionID', type: 'string' },
    { name: 'createdAtIso', type: 'string' }, { name: 'updatedAtIso', type: 'string' },
  ]);
});

test('defines the exact masked automation error schema', () => {
  assert.deepEqual(schema.automation_errors_v3, [
    { name: 'errorKey', type: 'string' }, { name: 'component', type: 'string' },
    { name: 'reconciliationStatus', type: 'string' }, { name: 'canonicalRowID', type: 'string' },
    { name: 'requestKey', type: 'string' }, { name: 'logicalJobKey', type: 'string' },
    { name: 'attemptKey', type: 'string' }, { name: 'executionID', type: 'string' },
    { name: 'workflowName', type: 'string' }, { name: 'nodeName', type: 'string' },
    { name: 'errorCode', type: 'string' }, { name: 'messageMasked', type: 'string' },
    { name: 'retryable', type: 'boolean' }, { name: 'createdAtIso', type: 'string' },
  ]);
});

test('provides resolved stream context in each ordered stream fixture', () => {
  assert.ok(orderedStreams.length > 0);
  for (const stream of orderedStreams) {
    assert.deepEqual(stream.streamContext, {
      liveStreamID: stream.liveStreamID,
      eligible: true,
      beginTime: 1787360400,
      endTime: 1787364000,
    });
  }
});

test('never replaces an existing canonical with a later smaller-id row', () => {
  const rows = [
    { id: 'row-z', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-z', sideEffectDone: true },
    { id: 'row-a', createdAt: '2026-08-22T00:01:00.000Z', reconciliationStatus: 'pending' },
  ];
  const reconciled = reconcileRows(rows);
  assert.equal(reconciled.canonical.id, 'row-z');
  assert.equal(reconciled.duplicates[0].canonicalRowID, 'row-z');
  assert.equal(reconciled.duplicates[0].reconciliationStatus, 'duplicate');
});

test('chooses the earliest createdAt and id only when no canonical exists', () => {
  const rows = [
    { id: 'row-b', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'pending' },
    { id: 'row-a', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'pending' },
  ];
  assert.equal(reconcileRows(rows).canonical.id, 'row-a');
});

test('uses code-unit id order for mixed-case election when no canonical exists', () => {
  const rows = [
    { id: 'row-a', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'pending' },
    { id: 'row-Z', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'pending' },
  ];

  assert.equal(reconcileRows(rows).canonical.id, 'row-Z');
});

test('concurrent canonical election converges only before checkpoints', () => {
  const result = resolveCanonicalConflict([
    { id: 'row-b', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-b' },
    { id: 'row-a', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-a' },
  ]);
  assert.equal(result.action, 'reconcile');
  assert.equal(result.canonical.id, 'row-a');
  assert.deepEqual(result.demoteRowIDs, ['row-b']);
});

test('uses code-unit id order for mixed-case canonical convergence', () => {
  const result = resolveCanonicalConflict([
    { id: 'row-a', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-a' },
    { id: 'row-Z', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-Z' },
  ]);

  assert.equal(result.action, 'reconcile');
  assert.equal(result.canonical.id, 'row-Z');
  assert.deepEqual(result.demoteRowIDs, ['row-a']);
});

test('concurrent election chooses among canonicals rather than pending rows', () => {
  const rows = [
    { id: 'row-pending', createdAt: '2026-08-21T23:59:00.000Z', reconciliationStatus: 'pending' },
    { id: 'row-b', createdAt: '2026-08-22T00:00:01.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-b' },
    { id: 'row-a', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-a' },
  ];

  assert.equal(reconcileRows(rows).canonical.id, 'row-a');
});

test('multiple canonicals with any checkpoint require manual review', () => {
  const result = resolveCanonicalConflict([
    { id: 'row-a', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical' },
    { id: 'row-b', createdAt: '2026-08-22T00:00:01.000Z', reconciliationStatus: 'canonical', submittedAtIso: '2026-08-22T00:01:00.000Z' },
  ]);
  assert.deepEqual(result, { action: 'manual_review', reason: 'multiple_canonical_checkpoint_conflict' });
});
