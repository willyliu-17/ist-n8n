const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowDir = path.resolve(__dirname, '..');
const schema = require('../../automation_provision_state_v3_AutomationProvV3A1/nodes/State_Schema/schema.json');
const workflow = JSON.parse(fs.readFileSync(path.join(workflowDir, 'workflow.json'), 'utf8'));
const {
  ATTEMPT_CHECKPOINT_FIELDS,
  ATTEMPT_FIELDS,
  ATTEMPT_IMMUTABLE_FIELDS,
  REPAIR_CLASS_CAP,
  REPAIR_CLASS_ORDER,
  REQUEST_FIELDS,
  REQUEST_IMMUTABLE_FIELDS,
  REQUEST_STAGES,
  RESOLUTION_EPOCH_ISO,
  SCHEMA_KEYS,
  SUMMARY_CHECKPOINT_FIELDS,
  addMinutes,
  aggregateLogicalJobs,
  buildNextAttempt,
  classifyAttemptFailure,
  compareRows,
  hasCheckpoint,
  immutableAttemptMatches,
  isAutomaticCandidate,
  maskedAuditPlans,
  maskText,
  nextRetryDelayMs,
  nonempty,
  parseExistingDialogues,
  parseOrderedStreams,
  planAttemptFailurePatch,
  planAttemptManualResolution,
  planAutoRetryOldTransition,
  planBoundedClass,
  planCapErrorRows,
  planPendingCapErrorCanonical,
  planRepairCapError,
  planCallbackDeadline,
  planCreationRepair,
  planExpiredDispatchLease,
  planManualRetryOldTransition,
  planMissedEvent,
  planNextAttemptReconciliation,
  planPresentationLease,
  planPresentationOwnerCall,
  planPresentationRepair,
  planRepairScan,
  planRequestResolution,
  planRetry,
  planRetryMaterializationClaim,
  planRequestReconciliation,
  planSameKeyReconciliation,
  planSummaryFailurePatch,
  planSummaryLease,
  runRequestResolution,
  strictIso,
  validateAttemptRow,
  validatePrimitive,
  validateRequestRow,
  validateRequestRows,
  verifyCapErrorReconciliation,
  verifyDuplicateCapError,
  verifyNextRows,
  verifyOldTransition,
  verifyPresentationRepair,
  verifySameKeyReconciliation,
} = require('../nodes/Plan_Repairs/jsCode');

const NOW = '2026-08-24T00:00:00.000Z';
const LATER = '2026-08-24T00:10:00.000Z';
const KEY = 'summary:req-001';
const LOGICAL = 'summary:req-001:current:9001:fromStart';
const CHANNEL = 'C0A4JJJKJMD';
const STREAM_CONTEXT = JSON.stringify({
  liveStreamID: '9001', eligible: true, beginTime: 1787360400, endTime: 1787364000,
});
const systemIDs = new Map();

function systemID(value) {
  if (Number.isInteger(value) && value > 0) return value;
  if (!systemIDs.has(value)) systemIDs.set(value, systemIDs.size + 1);
  return systemIDs.get(value);
}

function referenceID(value) {
  return systemIDs.has(value) ? String(systemID(value)) : value;
}

function attempt(overrides = {}) {
  const number = Number(overrides.attempt || 1);
  const id = systemID(overrides.id || `attempt-${number}`);
  const base = {
    id,
    createdAt: NOW,
    updatedAt: NOW,
    attemptKey: `${LOGICAL}:${number}`,
    logicalJobKey: LOGICAL,
    requestKey: KEY,
    requestType: 'suspect',
    attempt: number,
    role: 'current',
    streamID: '9001',
    mode: 'fromStart',
    durationMinutes: 5,
    streamContextJson: STREAM_CONTEXT,
    status: 'retry_pending',
    callbackTokenHash: '',
    reconciliationStatus: 'canonical',
    canonicalRowID: String(id),
    dispatchLeaseOwner: '',
    dispatchLeaseUntilIso: '',
    submittedAtIso: '',
    callbackDeadlineAtIso: '',
    manualReviewReason: '',
    manualReviewAtIso: '',
    manualReviewResolution: '',
    callbackTokenExpiresAtIso: '',
    consumedAtIso: '',
    channel: CHANNEL,
    threadTS: '1787364000.000001',
    processingMessageTS: '1787364001.000002',
    dialogue: '',
    language: '',
    errorCode: '',
    nextRetryAtIso: '2026-08-23T23:59:00.000Z',
    retryLeaseOwner: '',
    retryLeaseUntilIso: '',
    duplicateCount: 0,
    presentationStatus: 'pending',
    presentationLeaseOwner: '',
    presentationLeaseUntilIso: '',
    presentationAttempt: 0,
    presentationNextRetryAtIso: '',
    presentationErrorCode: '',
    transcriptUploadID: '',
    analysisUploadID: '',
    processingMessageUpdatedAtIso: '',
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
    id,
  };
  base.canonicalRowID = Object.hasOwn(overrides, 'canonicalRowID')
    ? referenceID(overrides.canonicalRowID)
    : String(base.id);
  return base;
}

function request(overrides = {}) {
  const id = systemID(overrides.id || 'request-a');
  const base = {
    id,
    createdAt: NOW,
    updatedAt: NOW,
    requestKey: KEY,
    requestType: 'suspect',
    status: 'summary_dispatching',
    creationLeaseOwner: '',
    reconciliationStatus: 'canonical',
    canonicalRowID: id,
    creationLeaseUntilIso: '',
    orderedStreamsJson: JSON.stringify([{
      role: 'current',
      liveStreamID: '9001',
      mode: 'fromStart',
      durationMinutes: 5,
      streamContext: { liveStreamID: '9001', eligible: true, beginTime: 1787360400, endTime: 1787364000 },
    }]),
    existingDialoguesJson: '{}',
    expectedLogicalJobKeysJson: JSON.stringify([LOGICAL]),
    channel: CHANNEL,
    threadTS: '1787364000.000001',
    coverageStatus: 'pending',
    availableRolesJson: '[]',
    missingRolesJson: '[]',
    failedLogicalJobKeysJson: '[]',
    leaseOwner: 'owner-1',
    leaseUntilIso: '2026-08-24T00:05:00.000Z',
    summaryAttempt: 0,
    nextRetryAtIso: '',
    errorCode: '',
    inferenceResultJson: '',
    summaryMarkdown: '',
    summaryMessageTS: '',
    summaryUploadID: '',
    manualReviewReason: '',
    manualReviewAtIso: '',
    manualReviewResolution: '',
    manualReviewOriginalStage: '',
    manualResolutionWinnerRowID: '',
    manualResolutionDecisionID: '',
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
    id,
  };
  base.canonicalRowID = Object.hasOwn(overrides, 'canonicalRowID')
    ? referenceID(overrides.canonicalRowID)
    : String(base.id);
  return base;
}

function manual(id, stage = 'ready', checkpoint = '') {
  return request({
    id,
    canonicalRowID: String(systemID(id)),
    status: 'manual_review',
    manualReviewOriginalStage: stage,
    summaryMarkdown: checkpoint,
    createdAt: id === 'request-a' ? NOW : LATER,
    updatedAt: id === 'request-a' ? NOW : LATER,
    manualReviewResolution: '',
    manualResolutionDecisionID: '',
    manualResolutionWinnerRowID: '',
    leaseOwner: '',
    leaseUntilIso: '',
  });
}

test('primitives are validated and system (createdAt,id) order uses strict numeric IDs', () => {
  assert.equal(validatePrimitive('x', 'f'), 'x');
  assert.equal(validatePrimitive(0, 'f'), 0);
  assert.equal(validatePrimitive(true, 'f'), true);
  assert.throws(() => validatePrimitive(null, 'f'), /Invalid primitive/);
  assert.throws(() => validatePrimitive(Number.NaN, 'f'), /Invalid primitive/);
  assert.throws(() => validatePrimitive([], 'f'), /Invalid primitive/);
  assert.throws(() => strictIso('2026-08-24T00:00:00Z', 'x'), /Invalid x/);
  assert.throws(() => strictIso('2026-08-24 00:00:00', 'x'), /Invalid x/);
  assert.equal(strictIso(NOW, 'x'), Date.parse(NOW));

  const a = attempt({ id: 2, createdAt: NOW });
  const z = attempt({ id: 1, createdAt: NOW });
  assert.equal(compareRows(z, a), -1);
  assert.equal(compareRows(a, z), 1);
  const earlier = attempt({ id: 3, createdAt: '2026-08-23T00:00:00.000Z' });
  assert.equal(compareRows(earlier, a), -1);
  assert.throws(() => compareRows(attempt({ createdAt: 'bad' }), a), /Invalid createdAt/);
});

test('full 44-field attempt schema matches the provisioned stt_jobs_v3 contract', () => {
  assert.deepEqual(ATTEMPT_FIELDS, schema.stt_jobs_v3.map(({ name }) => name));
  assert.deepEqual(REQUEST_FIELDS, schema.summary_requests_v3.map(({ name }) => name));
  assert.deepEqual(ATTEMPT_CHECKPOINT_FIELDS, [
    'submittedAtIso', 'callbackDeadlineAtIso', 'consumedAtIso', 'dialogue',
    'transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso',
  ]);
  assert.deepEqual(SUMMARY_CHECKPOINT_FIELDS, [
    'inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS',
  ]);
  assert.deepEqual(ATTEMPT_IMMUTABLE_FIELDS, [
    'attemptKey', 'logicalJobKey', 'requestKey', 'requestType', 'attempt', 'role',
    'streamID', 'mode', 'durationMinutes', 'streamContextJson', 'channel', 'threadTS',
    'processingMessageTS',
  ]);
  assert.deepEqual(REQUEST_IMMUTABLE_FIELDS, [
    'requestKey', 'requestType', 'orderedStreamsJson', 'existingDialoguesJson',
    'expectedLogicalJobKeysJson', 'channel', 'threadTS',
  ]);
  assert.ok(validateAttemptRow(attempt()));
  assert.throws(() => validateAttemptRow({ ...attempt(), id: 0 }), /system field/);
  assert.throws(() => validateAttemptRow(attempt({ attemptKey: 'broken' })), /attempt identity/);
  assert.throws(() => validateAttemptRow(attempt({ channel: 'C09F0SYG57D' })), /channel/);
  assert.throws(() => validateAttemptRow(attempt({ mode: 'first' })), /mode/);
});

test('explicit 4xx except 429 maps to terminal failed on any attempt', () => {
  for (const statusCode of [400, 401, 404, 422, 499]) {
    for (const attemptNumber of [1, 2, 3]) {
      const result = classifyAttemptFailure({ statusCode }, attemptNumber, NOW);
      assert.deepEqual(result, {
        classification: 'terminal_http_failure',
        status: 'failed',
        errorCode: `vds_http_${statusCode}`,
        nextRetryAtIso: '',
      }, `${statusCode} attempt ${attemptNumber}`);
    }
  }
});

test('429 and known retryable 5xx follow 1m/5m/terminal attempt table', () => {
  for (const statusCode of [429, 500, 502, 503, 504]) {
    const one = classifyAttemptFailure({ statusCode }, 1, NOW);
    assert.equal(one.status, 'retry_pending');
    assert.equal(one.nextRetryAtIso, '2026-08-24T00:01:00.000Z');
    assert.equal(one.errorCode, `vds_http_${statusCode}`);
    const two = classifyAttemptFailure({ statusCode }, 2, NOW);
    assert.equal(two.status, 'retry_pending');
    assert.equal(two.nextRetryAtIso, '2026-08-24T00:05:00.000Z');
    const three = classifyAttemptFailure({ statusCode }, 3, NOW);
    assert.equal(three.status, 'failed');
    assert.equal(three.nextRetryAtIso, '');
    assert.equal(three.classification, 'retry_exhausted');
  }
});

test('uncertain transport outcome routes to manual review with no automatic retry', () => {
  for (const attemptNumber of [1, 2, 3]) {
    for (const outcome of [{ transportError: true }, { outcomeUncertain: true }, {}]) {
      const result = classifyAttemptFailure(outcome, attemptNumber, NOW);
      assert.deepEqual(result, {
        classification: 'ambiguous_transport',
        status: 'manual_review',
        manualReviewReason: 'vds_submit_outcome_ambiguous',
        manualReviewAtIso: NOW,
        nextRetryAtIso: '',
        errorCode: '',
      }, `attempt ${attemptNumber} ${JSON.stringify(outcome)}`);
    }
  }
});

test('empty callback and retryable service error follow the 1m/5m/failed table', () => {
  for (const outcome of [{ callbackEmpty: true }, { retryableServiceError: true }]) {
    const one = classifyAttemptFailure(outcome, 1, NOW);
    assert.equal(one.status, 'retry_pending');
    assert.equal(one.nextRetryAtIso, '2026-08-24T00:01:00.000Z');
    const two = classifyAttemptFailure(outcome, 2, NOW);
    assert.equal(two.nextRetryAtIso, '2026-08-24T00:05:00.000Z');
    const three = classifyAttemptFailure(outcome, 3, NOW);
    assert.equal(three.status, 'failed');
    assert.equal(three.nextRetryAtIso, '');
  }
  assert.equal(classifyAttemptFailure({ callbackEmpty: true }, 1, NOW).errorCode, 'callback_empty_transcription');
  assert.equal(classifyAttemptFailure({ retryableServiceError: true }, 1, NOW).errorCode, 'callback_retryable_service_error');
});

test('callback deadline maps to retry_pending then timed_out terminal on attempt 3', () => {
  const one = classifyAttemptFailure({ deadlineExceeded: true }, 1, NOW);
  assert.equal(one.status, 'retry_pending');
  assert.equal(one.nextRetryAtIso, '2026-08-24T00:01:00.000Z');
  assert.equal(one.errorCode, 'callback_deadline_exceeded');
  const two = classifyAttemptFailure({ deadlineExceeded: true }, 2, NOW);
  assert.equal(two.nextRetryAtIso, '2026-08-24T00:05:00.000Z');
  const three = classifyAttemptFailure({ deadlineExceeded: true }, 3, NOW);
  assert.deepEqual(three, {
    classification: 'callback_deadline_exhausted',
    status: 'timed_out',
    errorCode: 'callback_deadline_exceeded',
    nextRetryAtIso: '',
  });
});

test('unclassified 5xx never auto-resends and invalid attempt numbers fail closed', () => {
  const result = classifyAttemptFailure({ statusCode: 501 }, 1, NOW);
  assert.equal(result.status, 'manual_review');
  assert.equal(result.manualReviewReason, 'vds_http_unclassified_server_response');
  assert.equal(result.nextRetryAtIso, '');
  assert.throws(() => classifyAttemptFailure({ statusCode: 429 }, 0, NOW), /Invalid attempt number/);
  assert.throws(() => classifyAttemptFailure({ statusCode: 429 }, 4, NOW), /Invalid attempt number/);
  assert.throws(() => classifyAttemptFailure({ statusCode: 429 }, 1, 'bad-iso'), /Invalid current time/);
});

test('attempt failure patch clears dispatch lease and uses exact canonical CAS filters', () => {
  const dispatching = attempt({ status: 'dispatching', dispatchLeaseOwner: 'exec-1', dispatchLeaseUntilIso: LATER });
  const patch = planAttemptFailurePatch(dispatching, { statusCode: 429 }, NOW);
  assert.equal(patch.action, 'retryable_http_failure');
  assert.deepEqual(patch.filters, {
    id: dispatching.id,
    attemptKey: dispatching.attemptKey,
    reconciliationStatus: 'canonical',
    canonicalRowID: String(dispatching.id),
    status: 'dispatching',
  });
  assert.equal(patch.desired.status, 'retry_pending');
  assert.equal(patch.desired.nextRetryAtIso, '2026-08-24T00:01:00.000Z');
  assert.equal(patch.desired.errorCode, 'vds_http_429');
  assert.equal(patch.desired.dispatchLeaseOwner, '');
  assert.equal(patch.desired.dispatchLeaseUntilIso, '');
  assert.equal(patch.desired.updatedAtIso, NOW);

  const waiting = attempt({ status: 'waiting_callback', callbackDeadlineAtIso: NOW });
  const deadline = planAttemptFailurePatch(waiting, { deadlineExceeded: true }, NOW);
  assert.equal(deadline.desired.status, 'retry_pending');
  assert.equal(deadline.desired.nextRetryAtIso, '2026-08-24T00:01:00.000Z');

  const manual = planAttemptFailurePatch(dispatching, { transportError: true }, NOW);
  assert.equal(manual.desired.status, 'manual_review');
  assert.equal(manual.desired.manualReviewReason, 'vds_submit_outcome_ambiguous');
  assert.equal(manual.desired.nextRetryAtIso, '');
});

test('summary failure patch atomically increments 1/2/3 with exact owner snapshot', () => {
  const owner = { leaseOwner: 'owner-1', leaseUntilIso: '2026-08-24T00:05:00.000Z' };
  const one = planSummaryFailurePatch(request({ summaryAttempt: 0, ...owner }), NOW, 'summary_inference_failed');
  assert.equal(one.action, 'schedule_retry');
  assert.equal(one.summaryAttempt, 1);
  assert.equal(one.desired.status, 'summary_retry_pending');
  assert.equal(one.desired.summaryAttempt, 1);
  assert.equal(one.desired.nextRetryAtIso, '2026-08-24T00:01:00.000Z');
  assert.equal(one.desired.errorCode, 'summary_inference_failed');
  assert.equal(one.desired.leaseOwner, '');
  assert.equal(one.desired.leaseUntilIso, '');
  assert.deepEqual(one.filters, {
    id: systemID('request-a'),
    requestKey: KEY,
    status: 'summary_dispatching',
    reconciliationStatus: 'canonical',
    canonicalRowID: String(systemID('request-a')),
    leaseOwner: 'owner-1',
    leaseUntilIso: '2026-08-24T00:05:00.000Z',
    summaryAttempt: 0,
  });

  const two = planSummaryFailurePatch(request({ summaryAttempt: 1, ...owner }), NOW, 'summary_inference_failed');
  assert.equal(two.summaryAttempt, 2);
  assert.equal(two.desired.nextRetryAtIso, '2026-08-24T00:05:00.000Z');

  const three = planSummaryFailurePatch(request({ summaryAttempt: 2, ...owner }), NOW, 'summary_inference_failed');
  assert.equal(three.action, 'fail');
  assert.equal(three.desired.status, 'failed');
  assert.equal(three.desired.summaryAttempt, 3);
  assert.equal(three.desired.nextRetryAtIso, '');
  assert.equal(three.desired.leaseOwner, '');
  assert.equal(three.desired.leaseUntilIso, '');

  assert.throws(() => planSummaryFailurePatch(request({ status: 'ready' }), NOW), /summary_dispatching/);
  assert.throws(() => planSummaryFailurePatch(request({ leaseOwner: '' }), NOW), /lease owner/);
  assert.throws(() => planSummaryFailurePatch(request({ summaryAttempt: 3 }), NOW), /Invalid summary attempt/);
});

test('planRetry materializes attempt+1 with deterministic key and 1m/5m delays', () => {
  assert.deepEqual(planRetry(attempt({ attempt: 1, status: 'retry_pending' })), {
    claimStatus: 'retry_materializing',
    nextAttempt: 2,
    nextAttemptKey: `${LOGICAL}:2`,
    nextRetryDelayMs: 60_000,
  });
  assert.deepEqual(planRetry(attempt({ attempt: 2, status: 'retry_pending' })), {
    claimStatus: 'retry_materializing',
    nextAttempt: 3,
    nextAttemptKey: `${LOGICAL}:3`,
    nextRetryDelayMs: 300_000,
  });
  assert.throws(() => planRetry(attempt({ attempt: 3, status: 'retry_pending' })), /terminal/);
});

test('retry claim soft-CASes due retry_pending into a five-minute retry lease', () => {
  const old = attempt({ attempt: 1, status: 'retry_pending', nextRetryAtIso: NOW });
  const claim = planRetryMaterializationClaim(old, NOW, 'exec-repair');
  assert.equal(claim.action, 'claim');
  assert.equal(claim.claimStatus, 'retry_materializing');
  assert.equal(claim.nextAttempt, 2);
  assert.equal(claim.nextAttemptKey, `${LOGICAL}:2`);
  assert.equal(claim.retryLeaseUntilIso, '2026-08-24T00:05:00.000Z');
  assert.deepEqual(claim.filters, {
    id: old.id,
    attemptKey: old.attemptKey,
    status: 'retry_pending',
    reconciliationStatus: 'canonical',
    canonicalRowID: String(old.id),
    nextRetryAtIso: NOW,
    retryLeaseOwner: '',
    retryLeaseUntilIso: '',
  });
  assert.deepEqual(claim.desired, {
    status: 'retry_materializing',
    retryLeaseOwner: 'exec-repair',
    retryLeaseUntilIso: '2026-08-24T00:05:00.000Z',
  });
  assert.equal(planRetryMaterializationClaim(attempt({ nextRetryAtIso: LATER }), NOW, 'x').action, 'noop');
});

test('expired retry lease is reclaimed with the same deterministic key', () => {
  const crashed = attempt({
    attempt: 1,
    status: 'retry_materializing',
    nextRetryAtIso: '2026-08-23T23:59:00.000Z',
    retryLeaseOwner: 'dead-exec',
    retryLeaseUntilIso: '2026-08-23T23:58:00.000Z',
  });
  const reclaim = planRetryMaterializationClaim(crashed, NOW, 'repair-2');
  assert.equal(reclaim.action, 'claim');
  assert.equal(reclaim.nextAttemptKey, `${LOGICAL}:2`);
  assert.equal(reclaim.desired.retryLeaseOwner, 'repair-2');
  assert.deepEqual(reclaim.filters, {
    id: crashed.id,
    attemptKey: crashed.attemptKey,
    status: 'retry_materializing',
    reconciliationStatus: 'canonical',
    canonicalRowID: String(crashed.id),
    nextRetryAtIso: '2026-08-23T23:59:00.000Z',
    retryLeaseOwner: 'dead-exec',
    retryLeaseUntilIso: '2026-08-23T23:58:00.000Z',
  });

  const active = attempt({
    status: 'retry_materializing',
    retryLeaseOwner: 'live-exec',
    retryLeaseUntilIso: '2026-08-24T00:03:00.000Z',
  });
  assert.equal(planRetryMaterializationClaim(active, NOW, 'repair-2').action, 'noop');
  assert.equal(planRetryMaterializationClaim(active, NOW, 'repair-2').reason, 'retry_lease_active');
  assert.throws(() => planRetryMaterializationClaim(attempt({ attempt: 3 }), NOW, 'x'), /terminal/);
});

test('buildNextAttempt inherits immutables and clears every side-effect field', () => {
  const old = attempt({
    attempt: 2,
    status: 'retry_materializing',
    dialogue: 'leaked',
    errorCode: 'old',
    transcriptUploadID: 'FOLD',
    dispatchLeaseOwner: 'leak',
    consumedAtIso: NOW,
  });
  const next = buildNextAttempt(old, NOW);
  assert.deepEqual(Object.keys(next), ATTEMPT_FIELDS);
  assert.equal(next.attemptKey, `${LOGICAL}:3`);
  assert.equal(next.logicalJobKey, LOGICAL);
  assert.equal(next.attempt, 3);
  assert.equal(next.role, 'current');
  assert.equal(next.streamID, '9001');
  assert.equal(next.mode, 'fromStart');
  assert.equal(next.durationMinutes, 5);
  assert.equal(next.streamContextJson, STREAM_CONTEXT);
  assert.equal(next.channel, CHANNEL);
  assert.equal(next.threadTS, old.threadTS);
  assert.equal(next.processingMessageTS, old.processingMessageTS);
  assert.equal(next.status, 'queued');
  assert.equal(next.reconciliationStatus, 'pending');
  assert.equal(next.canonicalRowID, '');
  assert.equal(next.dialogue, '');
  assert.equal(next.errorCode, '');
  assert.equal(next.transcriptUploadID, '');
  assert.equal(next.dispatchLeaseOwner, '');
  assert.equal(next.consumedAtIso, '');
  assert.equal(next.presentationAttempt, 0);
  assert.equal(next.duplicateCount, 0);
  assert.equal(next.createdAtIso, NOW);
  assert.ok(Object.values(next).every((value) => ['string', 'number', 'boolean'].includes(typeof value)));
  assert.throws(() => buildNextAttempt(attempt({ attempt: 3 }), NOW), /terminal/);
});

test('next-row reconciliation reuses one canonical and elects system earliest when absent', () => {
  const expected = buildNextAttempt(attempt({ attempt: 1 }), NOW);
  assert.deepEqual(planNextAttemptReconciliation([], expected), { action: 'insert', expected });

  const existing = attempt({
    attempt: 2,
    id: systemID('next-z'),
    attemptKey: `${LOGICAL}:2`,
    canonicalRowID: String(systemID('next-z')),
    status: 'queued',
  });
  const later = attempt({
    attempt: 2,
    id: systemID('next-a'),
    attemptKey: `${LOGICAL}:2`,
    createdAt: '2026-08-24T00:01:00.000Z',
    updatedAt: '2026-08-24T00:01:00.000Z',
    reconciliationStatus: 'pending',
    canonicalRowID: '',
    status: 'queued',
  });
  const plan = planNextAttemptReconciliation([existing, later], expected);
  assert.equal(plan.action, 'reconcile');
  assert.equal(plan.winnerRowID, systemID('next-z'));
  assert.deepEqual(plan.mutations.map(({ id, desiredReconciliationStatus, desiredCanonicalRowID }) => ({
    id, desiredReconciliationStatus, desiredCanonicalRowID,
  })), [{ id: systemID('next-a'), desiredReconciliationStatus: 'duplicate', desiredCanonicalRowID: String(systemID('next-z')) }]);

  const elected = planNextAttemptReconciliation([
    attempt({ attempt: 2, id: systemID('next-b'), attemptKey: `${LOGICAL}:2`, reconciliationStatus: 'pending', canonicalRowID: '', status: 'queued' }),
    attempt({ attempt: 2, id: systemID('next-a'), attemptKey: `${LOGICAL}:2`, reconciliationStatus: 'pending', canonicalRowID: '', status: 'queued' }),
  ], expected);
  assert.equal(elected.winnerRowID, systemID('next-a'));
  assert.throws(
    () => planNextAttemptReconciliation([{ ...existing, requestKey: 'summary:req-other' }], expected),
    /Immutable attempt payload conflict|request key mismatch/i,
  );
  assert.throws(
    () => planNextAttemptReconciliation([{ ...existing, mode: 'fromEnd' }], expected),
    /Immutable attempt payload conflict/i,
  );
});

test('next-row duplicate and checkpoint conflicts reuse the same key', () => {
  const expected = buildNextAttempt(attempt({ attempt: 1 }), NOW);
  const competing = [
    attempt({ attempt: 2, id: systemID('next-b'), attemptKey: `${LOGICAL}:2`, canonicalRowID: String(systemID('next-b')), status: 'queued' }),
    attempt({ attempt: 2, id: systemID('next-a'), attemptKey: `${LOGICAL}:2`, canonicalRowID: String(systemID('next-a')), status: 'queued' }),
  ];
  const clean = planNextAttemptReconciliation(competing, expected, []);
  assert.equal(clean.action, 'reconcile');
  assert.equal(clean.winnerRowID, systemID('next-a'));

  for (const checkpoint of ATTEMPT_CHECKPOINT_FIELDS) {
    const rows = competing.map((row) => ({ ...row }));
    rows[1][checkpoint] = `${checkpoint}-value`;
    const plan = planNextAttemptReconciliation(rows, expected, []);
    assert.equal(plan.action, 'manual_review', checkpoint);
    assert.equal(plan.mutations.length, 2);
  }
  for (const checkpoint of SUMMARY_CHECKPOINT_FIELDS) {
    const summaries = [{ requestKey: KEY, [checkpoint]: `${checkpoint}-value` }];
    assert.equal(planNextAttemptReconciliation(competing, expected, summaries).action, 'manual_review', checkpoint);
  }
  assert.throws(
    () => planNextAttemptReconciliation(competing, expected, [{ requestKey: 'summary:req-other', summaryMarkdown: 'x' }]),
    /Summary request key mismatch/i,
  );
});

test('next-row verifier rejects zero-CAS, partial, and multiple canonicals', () => {
  const expected = buildNextAttempt(attempt({ attempt: 1 }), NOW);
  const canonical = attempt({ attempt: 2, id: systemID('next-a'), attemptKey: `${LOGICAL}:2`, canonicalRowID: String(systemID('next-a')), status: 'queued' });
  const duplicate = attempt({ attempt: 2, id: systemID('next-b'), attemptKey: `${LOGICAL}:2`, reconciliationStatus: 'duplicate', canonicalRowID: String(systemID('next-a')), status: 'queued' });
  assert.equal(verifyNextRows([canonical, duplicate], { action: 'ready', winnerRowID: systemID('next-a') }).action, 'verified');
  assert.throws(() => verifyNextRows([], {}), /rows not found/);
  assert.throws(() => verifyNextRows([duplicate], {}), /exactly one canonical/);
  assert.throws(
    () => verifyNextRows([canonical, { ...duplicate, canonicalRowID: String(systemID('wrong')) }], {}),
    /loser linkage mismatch/,
  );
  const frozen = planNextAttemptReconciliation([
    attempt({ attempt: 2, id: systemID('next-a'), attemptKey: `${LOGICAL}:2`, canonicalRowID: String(systemID('next-a')), status: 'queued' }),
    attempt({ attempt: 2, id: systemID('next-b'), attemptKey: `${LOGICAL}:2`, canonicalRowID: String(systemID('next-b')), status: 'queued', submittedAtIso: NOW }),
  ], expected, []);
  const frozenRows = frozen.mutations.map(({ id }) => attempt({
    attempt: 2,
    id,
    attemptKey: `${LOGICAL}:2`,
    canonicalRowID: String(id),
    status: 'manual_review',
    manualReviewReason: 'multiple_canonical_checkpoint_conflict',
  }));
  assert.equal(verifyNextRows(frozenRows, frozen).action, 'verified_frozen');
  assert.throws(() => verifyNextRows(frozenRows.slice(0, 1), frozen), /freeze is incomplete/);
});

test('old row transitions to retry_materialized only with an exact lease snapshot', () => {
  const old = attempt({
    attempt: 1,
    status: 'retry_materializing',
    retryLeaseOwner: 'exec-repair',
    retryLeaseUntilIso: '2026-08-24T00:05:00.000Z',
  });
  const transition = planAutoRetryOldTransition(old, `${LOGICAL}:2`, NOW);
  assert.deepEqual(transition.filters, {
    id: old.id,
    attemptKey: old.attemptKey,
    status: 'retry_materializing',
    reconciliationStatus: 'canonical',
    canonicalRowID: String(old.id),
    retryLeaseOwner: 'exec-repair',
    retryLeaseUntilIso: '2026-08-24T00:05:00.000Z',
  });
  assert.deepEqual(transition.desired, {
    status: 'retry_materialized',
    retryLeaseOwner: '',
    retryLeaseUntilIso: '',
    manualReviewResolution: `retry_created:${LOGICAL}:2`,
    updatedAtIso: NOW,
  });

  const applied = attempt({
    attempt: 1,
    status: 'retry_materialized',
    retryLeaseOwner: '',
    retryLeaseUntilIso: '',
    manualReviewResolution: `retry_created:${LOGICAL}:2`,
  });
  assert.equal(verifyOldTransition([applied], transition).action, 'verified');
  assert.throws(() => verifyOldTransition([attempt({ status: 'retry_materializing' })], transition), /transition not verified/);
  assert.throws(() => verifyOldTransition([{ ...applied, manualReviewResolution: '' }], transition), /resolution link mismatch/);
  assert.throws(() => verifyOldTransition([{ ...applied, retryLeaseOwner: 'x' }], transition), /lease was not cleared/);
});

test('retry materialization sequencing only dispatches after verified old transition', () => {
  const old = attempt({ attempt: 1, status: 'retry_materializing', retryLeaseOwner: 'r', retryLeaseUntilIso: '2026-08-24T00:05:00.000Z' });
  const expected = buildNextAttempt(attempt({ attempt: 1 }), NOW);
  const inserted = attempt({ attempt: 2, id: systemID('next-a'), attemptKey: `${LOGICAL}:2`, canonicalRowID: String(systemID('next-a')), status: 'queued' });
  const reconciled = planNextAttemptReconciliation([inserted], expected);
  assert.equal(reconciled.action, 'ready');
  const verified = verifyNextRows([inserted], reconciled);
  assert.equal(verified.action, 'verified');
  const transition = planAutoRetryOldTransition(old, expected.attemptKey, NOW);
  const applied = attempt({
    attempt: 1,
    status: 'retry_materialized',
    retryLeaseOwner: '',
    retryLeaseUntilIso: '',
    manualReviewResolution: `retry_created:${expected.attemptKey}`,
  });
  assert.equal(verifyOldTransition([applied], transition).action, 'verified');
  const dispatch = { attemptKey: expected.attemptKey, requestKey: expected.requestKey };
  assert.deepEqual(dispatch, { attemptKey: `${LOGICAL}:2`, requestKey: KEY });
});

test('approved manual resolution requires approval and can fail a manual attempt', () => {
  const manualAttempt = attempt({ status: 'manual_review', manualReviewReason: 'vds_submit_outcome_ambiguous', manualReviewAtIso: NOW });
  assert.throws(() => planAttemptManualResolution(manualAttempt, { approved: true }, NOW), /approval reference/);
  assert.throws(() => planAttemptManualResolution(manualAttempt, { approvalRef: 'P10-1' }, NOW), /approval reference/);
  const failed = planAttemptManualResolution(manualAttempt, { approved: true, approvalRef: 'P10-1', decision: 'failed' }, NOW);
  assert.equal(failed.action, 'failed');
  assert.deepEqual(failed.filters, {
    id: manualAttempt.id,
    attemptKey: manualAttempt.attemptKey,
    status: 'manual_review',
    reconciliationStatus: 'canonical',
    canonicalRowID: String(manualAttempt.id),
    manualReviewResolution: '',
  });
  assert.equal(failed.desired.status, 'failed');
  assert.equal(failed.desired.manualReviewResolution, 'attempt_failed:manual_decision');
  assert.equal(failed.createsSttAttempt, false);
  assert.equal(failed.nextAttemptKey, '');
});

test('approved manual retry builds a deterministic next row then transitions the old row', () => {
  const manualAttempt = attempt({ status: 'manual_review', manualReviewReason: 'vds_submit_outcome_ambiguous', manualReviewAtIso: NOW });
  const approval = { approved: true, approvalRef: 'P10-2', decision: 'retry' };
  const retry = planAttemptManualResolution(manualAttempt, approval, NOW);
  assert.equal(retry.action, 'retry');
  assert.equal(retry.nextAttemptKey, `${LOGICAL}:2`);
  assert.equal(retry.desiredNext.attemptKey, `${LOGICAL}:2`);
  assert.equal(retry.desiredNext.status, 'queued');
  assert.equal(retry.createsSttAttempt, false);

  const transition = planManualRetryOldTransition(manualAttempt, retry.nextAttemptKey, approval, NOW);
  assert.deepEqual(transition.filters, {
    id: manualAttempt.id,
    attemptKey: manualAttempt.attemptKey,
    status: 'manual_review',
    reconciliationStatus: 'canonical',
    canonicalRowID: String(manualAttempt.id),
    manualReviewResolution: '',
  });
  assert.equal(transition.desired.status, 'retry_materialized');
  assert.equal(transition.desired.manualReviewResolution, `retry_created:${LOGICAL}:2`);
  assert.equal(transition.desired.retryLeaseOwner, '');
});

test('manual resolution crash rerun reuses the same key and different decisions fail closed', () => {
  const manualAttempt = attempt({ status: 'manual_review', manualReviewReason: 'vds_submit_outcome_ambiguous', manualReviewAtIso: NOW });
  const approval = { approved: true, approvalRef: 'P10-3', decision: 'retry' };
  const first = planAttemptManualResolution(manualAttempt, approval, NOW);
  const crashed = { ...manualAttempt, manualReviewResolution: `retry_created:${first.nextAttemptKey}` };
  const rerun = planAttemptManualResolution(crashed, approval, NOW);
  assert.equal(rerun.action, 'resolved');
  assert.equal(rerun.nextAttemptKey, first.nextAttemptKey);
  assert.throws(() => planAttemptManualResolution(crashed, { ...approval, decision: 'failed' }, NOW), /immutable/);
  assert.throws(() => planAttemptManualResolution({ ...manualAttempt, manualReviewResolution: 'garbage' }, approval, NOW), /Invalid persisted manual resolution/);
});

test('manual review rows are excluded from automatic repair plans', () => {
  const manualRow = attempt({ status: 'manual_review', manualReviewReason: 'vds_submit_outcome_ambiguous', manualReviewAtIso: NOW });
  assert.equal(isAutomaticCandidate(manualRow), false);
  const scan = planRepairScan({
    attemptRows: [manualRow, attempt({ status: 'dispatching', dispatchLeaseOwner: 'x', dispatchLeaseUntilIso: NOW })],
    requestRows: [],
    nowIso: NOW,
    leaseOwner: 'repair',
  });
  assert.equal(scan.plans.some((plan) => plan.id === manualRow.id), false);
  assert.equal(scan.plans.some((plan) => plan.repairClass === 'expired_dispatch_lease'), true);
});

test('request resolution selects only-checkpoint, identical-earliest, and explicit winners', () => {
  const one = planRequestResolution([manual('request-a'), manual('request-b', 'ready', 'checkpoint')], { approved: true, approvalRef: 'P10-r1', decisionID: 'd1' });
  assert.equal(one.winnerRowID, systemID('request-b'));
  assert.equal(one.selectionReason, 'only_checkpoint');
  const identical = planRequestResolution([manual('request-a', 'ready', 'same'), manual('request-b', 'ready', 'same')], { approved: true, approvalRef: 'P10-r2', decisionID: 'd2' });
  assert.equal(identical.winnerRowID, systemID('request-a'));
  assert.equal(identical.selectionReason, 'identical_checkpoints_system_earliest');
  const conflicting = [manual('request-a', 'ready', 'one'), manual('request-b', 'ready', 'two')];
  assert.throws(() => planRequestResolution(conflicting, { approved: true, approvalRef: 'P10-r3', decisionID: 'd3' }), /explicit winner/);
  assert.throws(() => planRequestResolution(conflicting, { approved: true, decisionID: 'd3', winnerRowID: systemID('request-a') }), /approval reference/);
  const explicit = planRequestResolution(conflicting, { approved: true, approvalRef: 'P10-r3', decisionID: 'd3', winnerRowID: String(systemID('request-b')) });
  assert.equal(explicit.winnerRowID, systemID('request-b'));
  assert.equal(explicit.selectionReason, 'explicit_checkpoint_winner');
});

test('request resolution failed decision follows the fixed canonical protocol without attempts', () => {
  const rows = [manual('request-a', 'ready', 'one'), manual('request-b', 'ready', 'two')];
  const result = runRequestResolution(rows, { approved: true, approvalRef: 'P10-r4', decisionID: 'd4', decision: 'failed' });
  assert.equal(result.winner.status, 'failed');
  assert.equal(result.winner.manualReviewResolution, 'request_failed:checkpoint_conflict');
  assert.equal(result.sideEffectCalls, 0);
  assert.ok(result.losers.every((row) => row.reconciliationStatus === 'duplicate'));
  assert.deepEqual(Object.keys(result.winner).filter((key) => key === 'attemptKey'), []);
});

test('request resolution restores every allowed original stage with exact lease handling', () => {
  for (const stage of ['ready', 'summary_dispatching', 'summary_retry_pending', 'completed']) {
    const result = runRequestResolution([manual('request-a', stage, 'checkpoint'), manual('request-b', stage)], { approved: true, approvalRef: `P10-${stage}`, decisionID: `d-${stage}` });
    assert.equal(result.winner.status, stage, stage);
    assert.equal(result.winner.manualReviewOriginalStage, stage, stage);
    assert.equal(result.winner.manualReviewResolution, `winner_selected:${systemID('request-a')}:resume:${stage}`, stage);
    if (stage === 'summary_dispatching') {
      assert.equal(result.winner.leaseOwner, '');
      assert.equal(result.winner.leaseUntilIso, RESOLUTION_EPOCH_ISO);
    }
    if (stage === 'summary_retry_pending' || stage === 'ready') {
      assert.equal(result.winner.leaseOwner, '');
      assert.equal(result.winner.leaseUntilIso, '');
    }
  }
});

test('request loser partial failure and pre-final crash retry the same immutable winner', () => {
  const rows = [manual('request-a', 'ready', 'same'), manual('request-b', 'ready', 'same'), manual('request-c', 'ready', 'same')];
  const approval = { approved: true, approvalRef: 'P10-r5', decisionID: 'd5' };
  const partial = runRequestResolution(rows, approval, { failLoserID: systemID('request-c') });
  assert.equal(partial.winner.status, 'manual_review');
  assert.equal(partial.winner.manualReviewResolution, '');
  assert.equal(partial.sideEffectCalls, 0);
  const retried = runRequestResolution(partial.rows, approval);
  assert.equal(retried.winner.id, systemID('request-a'));
  assert.equal(retried.reElected, false);
  assert.ok(retried.losers.every((row) => row.reconciliationStatus === 'duplicate' && row.canonicalRowID === String(systemID('request-a'))));
  assert.equal(retried.sideEffectCallsBeforeFinalPatch, 0);

  const crashRows = [manual('request-a', 'summary_dispatching', 'same'), manual('request-b', 'summary_dispatching', 'same')];
  const crash = runRequestResolution(crashRows, { approved: true, approvalRef: 'P10-r6', decisionID: 'd6' }, { crashBeforeWinnerFinalPatch: true });
  assert.equal(crash.canonicalRows.length, 1);
  assert.equal(crash.winner.manualReviewResolution, '');
  const finalRun = runRequestResolution(crash.rows, { approved: true, approvalRef: 'P10-r6', decisionID: 'd6' }, { resolutionIso: NOW });
  assert.equal(finalRun.winner.id, systemID('request-a'));
  assert.equal(finalRun.winner.status, 'summary_dispatching');
  assert.equal(finalRun.winner.leaseUntilIso, NOW);
  assert.equal(finalRun.sideEffectCallsBeforeFinalPatch, 0);
});

test('request resolution produces masked audits without summary content and rejects attempt identity', () => {
  const rows = [
    manual('request-a', 'ready', 'checkpoint'),
    manual('request-b', 'ready'),
    request({
      id: systemID('request-c'),
      status: 'manual_review',
      reconciliationStatus: 'duplicate',
      canonicalRowID: String(systemID('request-a')),
      manualReviewOriginalStage: 'ready',
      manualResolutionDecisionID: 'd7',
      manualResolutionWinnerRowID: String(systemID('request-a')),
      leaseOwner: '',
      leaseUntilIso: '',
    }),
  ];
  const plan = planRequestResolution(rows, { approved: true, approvalRef: 'P10-r7', decisionID: 'd7' });
  const audits = maskedAuditPlans(rows, plan, { approved: true, approvalRef: 'P10-r7' });
  assert.equal(audits.length, 3);
  for (const audit of audits) {
    assert.equal(audit.action, 'write_audit');
    assert.equal(audit.columns.attemptKey, '');
    assert.equal(audit.columns.logicalJobKey, '');
    assert.equal(audit.columns.errorCode, 'request_manual_resolution_audit');
    assert.equal(audit.columns.retryable, false);
    assert.doesNotMatch(audit.columns.messageMasked, /checkpoint-value|summaryMarkdown|inference/);
    assert.match(audit.columns.messageMasked, /checkpointDigest=[a-f0-9]{8}/);
    assert.match(audit.columns.errorKey, /^audit:v1:/);
  }
  assert.throws(() => planRequestResolution([{ ...manual('request-a'), attemptKey: 'leak' }], { approved: true, approvalRef: 'P10-r8', decisionID: 'd8' }), /attempt identity/);
});

test('presentation repair converts due retry and expired presenting to claimable pending', () => {
  const due = attempt({
    status: 'completed',
    presentationStatus: 'retry_pending',
    presentationAttempt: 1,
    presentationNextRetryAtIso: NOW,
  });
  const plan = planPresentationRepair(due, NOW);
  assert.equal(plan.action, 'claim');
  assert.equal(plan.desired.presentationStatus, 'pending');
  assert.equal(plan.desired.presentationLeaseOwner, '');
  assert.equal(plan.desired.presentationLeaseUntilIso, '');
  assert.deepEqual(plan.filters, {
    id: due.id,
    attemptKey: due.attemptKey,
    reconciliationStatus: 'canonical',
    canonicalRowID: String(due.id),
    status: 'completed',
    presentationStatus: 'retry_pending',
    presentationAttempt: 1,
    presentationLeaseOwner: '',
    presentationLeaseUntilIso: '',
  });
  assert.equal(planPresentationRepair(attempt({ status: 'completed', presentationStatus: 'retry_pending', presentationAttempt: 1, presentationNextRetryAtIso: LATER }), NOW).action, 'noop');

  const expired = attempt({
    status: 'completed',
    presentationStatus: 'presenting',
    presentationAttempt: 2,
    presentationLeaseOwner: 'dead-presenter',
    presentationLeaseUntilIso: '2026-08-23T23:59:00.000Z',
  });
  const expiredPlan = planPresentationRepair(expired, NOW);
  assert.equal(expiredPlan.action, 'claim');
  assert.equal(expiredPlan.desired.presentationStatus, 'pending');

  const active = attempt({
    status: 'completed',
    presentationStatus: 'presenting',
    presentationAttempt: 1,
    presentationLeaseOwner: 'live-presenter',
    presentationLeaseUntilIso: LATER,
  });
  assert.equal(planPresentationRepair(active, NOW).reason, 'presentation_lease_active');
  assert.throws(() => planPresentationRepair(attempt({ status: 'completed', presentationStatus: 'retry_pending', presentationAttempt: 3, presentationNextRetryAtIso: NOW }), NOW), /cap reached/);
  assert.throws(() => planPresentationRepair(attempt({ status: 'queued' }), NOW), /completed attempt/);
});

test('presentation owner is called only after a verified transition', () => {
  const due = attempt({
    status: 'completed',
    presentationStatus: 'retry_pending',
    presentationAttempt: 1,
    presentationNextRetryAtIso: NOW,
  });
  const plan = planPresentationRepair(due, NOW);
  const applied = attempt({ status: 'completed', presentationStatus: 'pending', presentationAttempt: 1, presentationLeaseOwner: '', presentationLeaseUntilIso: '' });
  assert.equal(verifyPresentationRepair([applied], plan).action, 'verified');
  assert.throws(() => verifyPresentationRepair([attempt({ status: 'completed', presentationStatus: 'retry_pending' })], plan), /transition not verified/);
  assert.throws(() => verifyPresentationRepair([], plan), /rows not found/);

  const call = planPresentationOwnerCall(applied);
  assert.deepEqual(call, {
    action: 'call_owner',
    repairClass: 'presentation_lease',
    targetWorkflow: 'STTListenerV3A01',
    input: { attemptKey: applied.attemptKey },
    requiresPreflight: true,
  });
  assert.throws(() => planPresentationOwnerCall(due), /verified pending transition/);
  assert.equal(planPresentationLease(attempt({ status: 'completed' }), NOW).reason, 'presentation_not_repairable');
});

test('bounded scan caps each class at fifty and masks a cap error for the fifty-first', () => {
  const many = [];
  for (let index = 0; index < 52; index += 1) {
    many.push(attempt({
      id: `cb-${index}`,
      status: 'waiting_callback',
      callbackDeadlineAtIso: NOW,
      createdAt: NOW,
    }));
  }
  const scan = planRepairScan({ attemptRows: many, requestRows: [], nowIso: NOW, leaseOwner: 'repair' });
  assert.equal(scan.plans.filter((plan) => plan.repairClass === 'callback_deadline').length, REPAIR_CLASS_CAP);
  assert.equal(scan.capErrors.length, 1);
  assert.equal(scan.capErrors[0].repairClass, 'callback_deadline');
  assert.equal(scan.capErrors[0].code, 'repair_scan_cap_exceeded');
  assert.equal(scan.capErrors[0].count, 52);
  assert.equal(scan.capErrors[0].messageMasked.length > 0, true);
  assert.deepEqual(scan.capErrors[0].createdAtIso, NOW);
});

test('expired dispatch lease is never auto-resent and routes to manual review', () => {
  const row = attempt({ status: 'dispatching', dispatchLeaseOwner: 'dead-exec', dispatchLeaseUntilIso: '2026-08-23T23:59:00.000Z' });
  const plan = planExpiredDispatchLease(row, NOW);
  assert.equal(plan.action, 'manual_review');
  assert.equal(plan.neverAutoResend, true);
  assert.equal(plan.desired.status, 'manual_review');
  assert.equal(plan.desired.manualReviewReason, 'dispatch_lease_expired_outcome_unknown');
  assert.equal(plan.desired.dispatchLeaseOwner, '');
  assert.equal(plan.desired.dispatchLeaseUntilIso, '');
  assert.equal(JSON.stringify(plan.desired).includes('retry_pending'), false);
});

test('repair scan plans every class deterministically in fixed order', () => {
  const rows = [
    attempt({ id: systemID('cb'), status: 'waiting_callback', callbackDeadlineAtIso: NOW }),
    attempt({ id: systemID('disp'), status: 'dispatching', dispatchLeaseOwner: 'x', dispatchLeaseUntilIso: NOW }),
    attempt({ id: systemID('retry'), status: 'retry_pending', nextRetryAtIso: NOW }),
    attempt({ id: systemID('pres'), status: 'completed', presentationStatus: 'retry_pending', presentationAttempt: 1, presentationNextRetryAtIso: NOW }),
  ];
  const reqs = [
    request({ id: systemID('req-ready'), status: 'ready', leaseOwner: '', leaseUntilIso: '' }),
    request({ id: systemID('req-creating'), status: 'creating', creationLeaseOwner: 'dead', creationLeaseUntilIso: NOW }),
  ];
  const scan = planRepairScan({ attemptRows: rows, requestRows: reqs, nowIso: NOW, leaseOwner: 'repair' });
  const classes = scan.plans.map((plan) => plan.repairClass);
  assert.deepEqual(new Set(classes), new Set([
    'expired_dispatch_lease', 'callback_deadline', 'retry_materialization',
    'creation_lease', 'summary_lease', 'presentation_lease', 'duplicate_deterministic_keys',
  ]));
  assert.ok(scan.plans.every((plan) => REPAIR_CLASS_ORDER.includes(plan.repairClass)));
});

test('missed-event plans carry only canonical deterministic keys with runtime preflight', () => {
  const queued = attempt({ status: 'queued', dispatchLeaseOwner: '', dispatchLeaseUntilIso: '' });
  const dispatchPlan = planMissedEvent('dispatch_queued', queued, { postTransitionVerified: true }, NOW);
  assert.deepEqual(dispatchPlan, {
    action: 'call_dispatcher',
    targetWorkflow: 'STTDispatchV3A01',
    input: { attemptKey: queued.attemptKey },
    requiresPreflight: true,
  });
  assert.throws(() => planMissedEvent('dispatch_queued', queued, {}, NOW), /post-transition/);
  assert.throws(() => planMissedEvent('dispatch_queued', attempt({ status: 'queued', dispatchLeaseOwner: 'x', dispatchLeaseUntilIso: LATER }), { postTransitionVerified: true }, NOW), /active dispatch lease/);

  const waiting = request({ status: 'waiting_stt' });
  const ready = request({ status: 'ready', leaseOwner: '', leaseUntilIso: '' });
  const expired = request({ status: 'summary_dispatching', leaseOwner: 'dead', leaseUntilIso: NOW });
  assert.deepEqual(planMissedEvent('coordinator_waiting_stt', waiting, {}, NOW), {
    action: 'call_coordinator',
    targetWorkflow: 'SummaryCoordV3A1',
    input: { requestKey: KEY },
    requiresPreflight: true,
  });
  assert.deepEqual(planMissedEvent('coordinator_ready', ready, {}, NOW).input, { requestKey: KEY });
  assert.throws(() => planMissedEvent('coordinator_ready', request({ status: 'ready', leaseOwner: 'active', leaseUntilIso: LATER }), {}, NOW), /active summary lease/);
  assert.deepEqual(planMissedEvent('coordinator_summary_expired', expired, {}, NOW).input, { requestKey: KEY });
  assert.throws(() => planMissedEvent('coordinator_summary_expired', request({ status: 'summary_dispatching', leaseOwner: 'a', leaseUntilIso: LATER }), {}, NOW), /not expired/);
  const summaryDue = planSummaryLease(request({ status: 'summary_retry_pending', leaseOwner: '', leaseUntilIso: '', nextRetryAtIso: NOW }), NOW);
  assert.equal(summaryDue.action, 'call_coordinator');
  assert.equal(summaryDue.input.requestKey, KEY);
});

test('creation repair rebuilds the exact orchestrator input from persisted JSON', () => {
  const creating = request({ status: 'creating', creationLeaseOwner: 'dead-exec', creationLeaseUntilIso: NOW, leaseOwner: '', leaseUntilIso: '' });
  const plan = planCreationRepair(creating, [], NOW);
  assert.equal(plan.action, 'resume_creation');
  assert.equal(plan.targetWorkflow, 'SummaryOrchV3A01');
  assert.equal(plan.requiresPreflight, true);
  assert.deepEqual(plan.input, {
    requestKey: KEY,
    requestType: 'suspect',
    orderedStreams: JSON.parse(creating.orderedStreamsJson),
    existingDialogues: {},
    channel: CHANNEL,
    threadTS: '1787364000.000001',
  });
  const active = planCreationRepair(request({ status: 'creating', creationLeaseOwner: 'live', creationLeaseUntilIso: LATER, leaseOwner: '', leaseUntilIso: '' }), [], NOW);
  assert.equal(active.action, 'noop');
  assert.equal(active.reason, 'creation_lease_active');
  assert.equal(planCreationRepair(request({ status: 'waiting_stt' }), [], NOW).action, 'noop');
  assert.throws(() => planCreationRepair(request({ status: 'creating', orderedStreamsJson: '[]', creationLeaseOwner: '', creationLeaseUntilIso: '', leaseOwner: '', leaseUntilIso: '' }), [], NOW), /Invalid ordered streams/);
  assert.throws(() => planCreationRepair(request({ status: 'creating', creationLeaseOwner: '', creationLeaseUntilIso: '', expectedLogicalJobKeysJson: '["wrong:key"]', leaseOwner: '', leaseUntilIso: '' }), [], NOW), /Immutable expected keys mismatch/);
});

test('scan treats creation, summary, presentation, and duplicate classes as one bounded planner', () => {
  const duplicateAttempts = [
    attempt({ id: systemID('dup-a'), attemptKey: `${LOGICAL}:1`, canonicalRowID: String(systemID('dup-a')), status: 'queued' }),
    attempt({ id: systemID('dup-b'), attemptKey: `${LOGICAL}:1`, canonicalRowID: String(systemID('dup-b')), status: 'queued' }),
  ];
  const scan = planRepairScan({
    attemptRows: duplicateAttempts,
    requestRows: [request({ id: systemID('req-ready'), status: 'ready', leaseOwner: '', leaseUntilIso: '' })],
    nowIso: NOW,
    leaseOwner: 'repair',
  });
  const duplicatePlan = scan.plans.find((plan) => plan.repairClass === 'duplicate_deterministic_keys');
  assert.equal(duplicatePlan.action, 'reconcile');
  assert.equal(duplicatePlan.winnerRowID, systemID('dup-a'));
  assert.ok(scan.plans.some((plan) => plan.repairClass === 'summary_lease' && plan.action === 'call_coordinator'));
  assert.ok(scan.capErrors.length === 0);
});

test('scan candidate ordering within a class is deterministic by system (createdAt,id)', () => {
  const late = attempt({ id: systemID('cb-b'), status: 'waiting_callback', callbackDeadlineAtIso: NOW, createdAt: '2026-08-24T00:00:01.000Z', updatedAt: '2026-08-24T00:00:01.000Z' });
  const early = attempt({ id: systemID('cb-a'), status: 'waiting_callback', callbackDeadlineAtIso: NOW, createdAt: NOW, updatedAt: NOW });
  const scan = planRepairScan({ attemptRows: [late, early], requestRows: [], nowIso: NOW, leaseOwner: 'repair' });
  const callbackPlans = scan.plans.filter((plan) => plan.repairClass === 'callback_deadline');
  assert.deepEqual(callbackPlans.map((plan) => plan.filters.id), [systemID('cb-a'), systemID('cb-b')]);
});

test('attempt 3 retryable failure patch is terminal failed with cleared dispatch lease', () => {
  const third = attempt({ attempt: 3, status: 'dispatching', dispatchLeaseOwner: 'exec-3', dispatchLeaseUntilIso: LATER });
  const patch = planAttemptFailurePatch(third, { statusCode: 503 }, NOW);
  assert.equal(patch.status, 'failed');
  assert.equal(patch.nextRetryAtIso, '');
  assert.equal(patch.desired.dispatchLeaseOwner, '');
  assert.equal(patch.desired.dispatchLeaseUntilIso, '');
  assert.equal(patch.desired.updatedAtIso, NOW);
});

function node(name) {
  const value = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(value, `missing node ${name}`);
  return value;
}

function targets(name, output = 0) {
  return (workflow.connections[name]?.main?.[output] || []).map(({ node: target }) => target);
}

test('runtime contract uses the exact inactive repair workflow identity', () => {
  assert.equal(workflow.id, 'AutoRepairV3A001');
  assert.equal(workflow.name, 'Automation: retry and repair v3');
  assert.equal(workflow.active, false);
  assert.equal(workflow.isArchived, false);
});

test('runtime has one inactive five-minute Schedule Trigger and no manual trigger', () => {
  const triggers = workflow.nodes.filter(({ type }) => type.endsWith('scheduleTrigger'));
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].parameters.rule.interval[0].minutesInterval, 5);
  assert.equal(workflow.nodes.some(({ type }) => type.endsWith('manualTrigger')), false);
});

test('runtime uses approved execution retention', () => {
  assert.deepEqual(workflow.settings, {
    executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all',
    saveManualExecutions: true, saveExecutionProgress: false,
  });
});

test('all seven repair classes are schedule-reachable', () => {
  assert.deepEqual(new Set(targets('Schedule Repair Tick')), new Set([
    'Read Expired Dispatch Candidates', 'Read Callback Deadline Candidates', 'Read Retry Materialization Candidates',
    'Read Creation Lease Candidates', 'Read Summary Missed Event Candidates', 'Read Presentation Repair Candidates',
    'Read Duplicate Key Candidates',
  ]));
});

for (const name of [
  'Expired Dispatch', 'Callback Deadline', 'Retry Materialization', 'Creation Lease',
  'Summary Missed Event', 'Presentation Repair', 'Duplicate Key',
]) {
  test(`${name} class has a hard cap of fifty before its next action`, () => {
    const limit = node(`Limit ${name} Candidates 50`);
    assert.equal(limit.type, 'n8n-nodes-base.limit');
    assert.equal(limit.parameters.maxItems, 50);
  });
}

test('candidate reads use only authoritative v3 tables and have empty-safe output', () => {
  for (const candidate of workflow.nodes.filter(({ name }) => name.startsWith('Read ') && name.endsWith('Candidates'))) {
    assert.equal(candidate.type, 'n8n-nodes-base.dataTable');
    assert.equal(candidate.alwaysOutputData, true);
    assert.ok(['stt_jobs_v3', 'summary_requests_v3'].includes(candidate.parameters.dataTableId.value));
    assert.equal(candidate.parameters.dataTableId.mode, 'name');
  }
});

test('every mutation has all-conditions, always-output, Limit 1, and a reread successor', () => {
  for (const mutation of workflow.nodes.filter(({ type, parameters }) => type === 'n8n-nodes-base.dataTable' && ['update', 'insert'].includes(parameters.operation))) {
    assert.equal(mutation.parameters.matchType, mutation.parameters.operation === 'insert' ? undefined : 'allConditions', mutation.name);
    assert.equal(mutation.alwaysOutputData, true, mutation.name);
    const [limitName] = targets(mutation.name);
    assert.match(limitName || '', /^Limit /, mutation.name);
    assert.equal(node(limitName).parameters.maxItems, 1, mutation.name);
    assert.match(targets(limitName)[0] || '', /read|verify/i, mutation.name);
  }
});

test('expired dispatch repair is an exact manual-review freeze and never dispatches', () => {
  const patch = node('Freeze Expired Dispatch Manual Review');
  assert.equal(patch.parameters.columns.value.status, '={{ $json.plan.desired.status }}');
  assert.equal(patch.parameters.columns.value.manualReviewReason, '={{ $json.plan.desired.manualReviewReason }}');
  assert.deepEqual(targets('Plan Expired Dispatch Actual'), ['Freeze Expired Dispatch Manual Review']);
  assert.deepEqual(targets('Verify Expired Dispatch Manual Review'), ['Repair Side Effect Sink']);
});

test('retry claim uses a direct carrier plus two-input append Merge', () => {
  const merge = node('Merge Retry Claim Plan And Reread');
  assert.equal(merge.parameters.mode, 'append');
  assert.equal(merge.parameters.numberInputs, 2);
  assert.ok(targets('Carry Retry Claim Plan').includes('Claim Retry Materialization Exact'));
  assert.ok(targets('Carry Retry Claim Plan').includes(merge.name));
  assert.deepEqual(targets('Re-read Retry Claim Owner'), [merge.name]);
});

test('retry claim exact filters snapshot status, canonical linkage, due time, and lease pair', () => {
  const keys = node('Claim Retry Materialization Exact').parameters.filters.conditions.map(({ keyName }) => keyName);
  assert.deepEqual(keys, ['id', 'attemptKey', 'status', 'reconciliationStatus', 'canonicalRowID', 'nextRetryAtIso', 'retryLeaseOwner', 'retryLeaseUntilIso']);
});

test('retry owner verifier fans out only to the next-row reread and its direct carrier merge', () => {
  assert.deepEqual(targets('Merge Retry Claim Plan And Reread'), ['Tag Verify Retry Claim Owner']);
  assert.deepEqual(targets('Tag Verify Retry Claim Owner'), ['Verify Retry Claim Owner']);
  assert.deepEqual(new Set(targets('Verify Retry Claim Owner')), new Set(['Read Next Retry Attempt Rows', 'Merge Retry Next Carrier And Rows']));
});

test('retry insert has a bounded reread crash boundary', () => {
  assert.deepEqual(targets('Insert Next Retry Attempt'), ['Limit Next Retry Insert']);
  assert.deepEqual(targets('Limit Next Retry Insert'), ['Re-read Next Retry Insert Rows']);
});

test('old retry transition has exact owner lease snapshot and is reached only after next reconciliation', () => {
  const keys = node('Transition Old Retry Materialized Exact').parameters.filters.conditions.map(({ keyName }) => keyName);
  assert.ok(keys.includes('retryLeaseOwner'));
  assert.ok(keys.includes('retryLeaseUntilIso'));
  assert.deepEqual(targets('Verify Next Retry Reconciliation'), ['Tag Plan Auto Retry Old Transition']);
  assert.deepEqual(targets('Tag Plan Auto Retry Old Transition'), ['Plan Auto Retry Old Transition']);
  assert.deepEqual(new Set(targets('Plan Auto Retry Old Transition')), new Set([
    'Transition Old Retry Materialized Exact', 'Merge Retry Old Carrier And Rereads',
  ]));
});

test('dispatcher is downstream of the verified old transition and full preflight', () => {
  assert.deepEqual(targets('Limit Old Retry Transition'), ['Re-read Old Retry Transition']);
  assert.deepEqual(targets('Verify Auto Retry Old Transition'), ['Re-read Next Before Retry Dispatch']);
  assert.deepEqual(targets('Re-read Next Before Retry Dispatch'), ['Preflight Canonical Next Retry Dispatch']);
  assert.deepEqual(targets('Preflight Canonical Next Retry Dispatch'), ['Dispatch Canonical Next Retry Attempt']);
});

test('retry dispatcher has the canonical inventory selector, canonical input, and sink', () => {
  const call = node('Dispatch Canonical Next Retry Attempt');
  assert.equal(call.parameters.workflowId.value, 'STTDispatchV3A01');
  assert.equal(call.parameters.workflowId.cachedResultName, 'STT: dispatch attempt v3');
  assert.deepEqual(Object.keys(call.parameters.workflowInputs.value), ['attemptKey']);
  assert.deepEqual(targets(call.name), ['Repair Side Effect Sink']);
});

test('creation repair only scans creating requests and calls the typed orchestrator selector', () => {
  assert.equal(node('Read Creation Lease Candidates').parameters.filters.conditions[0].keyValue, 'creating');
  const call = node('Resume Creating Request Orchestrator');
  assert.equal(call.parameters.workflowId.value, 'SummaryOrchV3A01');
  assert.deepEqual(Object.keys(call.parameters.workflowInputs.value), [
    'requestKey', 'requestType', 'orderedStreams', 'existingDialogues', 'channel', 'threadTS',
  ]);
});

test('summary missed-event call uses the coordinator selector and requestKey only', () => {
  const call = node('Run Summary Coordinator Missed Event');
  assert.equal(call.parameters.workflowId.value, 'SummaryCoordV3A1');
  assert.equal(call.parameters.workflowId.cachedResultName, 'Summary: coordinator v3');
  assert.deepEqual(Object.keys(call.parameters.workflowInputs.value), ['requestKey']);
});

test('presentation missed-event call uses the listener selector and attemptKey only', () => {
  const call = node('Run Presentation Owner Repair');
  assert.equal(call.parameters.workflowId.value, 'STTListenerV3A01');
  assert.equal(call.parameters.workflowId.cachedResultName, 'STT result listener v3');
  assert.deepEqual(Object.keys(call.parameters.workflowInputs.value), ['attemptKey']);
});

test('manual review has no automatic repair candidate or side-effect path', () => {
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /executeWorkflowTrigger|manualTrigger/);
  assert.doesNotMatch(serialized, /attempt_manual_resolution|request_manual_resolution/);
});

test('runtime contains no credentials, secrets, candidate table, legacy table, or named-run lookup', () => {
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /"credentials"|suspect_stt_candidates_v3|legacy|\$runIndex|\.isExecuted/);
});

test('all node IDs are unique UUIDv4 values and all connection targets exist', () => {
  const ids = workflow.nodes.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)));
  const names = new Set(workflow.nodes.map(({ name }) => name));
  for (const output of Object.values(workflow.connections)) for (const branch of output.main) for (const target of branch) assert.ok(names.has(target.node));
});

for (const [name, check] of [
  ['absent next rows route only through the insert branch', () => assert.deepEqual(targets('Route Next Retry Insert', 0), ['Carry Next Retry Insert Plan'])],
  ['existing next rows skip insert', () => assert.deepEqual(targets('Route Next Retry Insert', 1), ['Route Next Retry Reconcile'])],
  ['insert carries the complete expected row directly', () => assert.ok(targets('Carry Next Retry Insert Plan').includes('Insert Next Retry Attempt'))],
  ['insert rereads the same deterministic next key', () => assert.deepEqual(targets('Limit Next Retry Insert'), ['Re-read Next Retry Insert Rows'])],
  ['next planner receives rows plus direct claim carrier', () => assert.equal(node('Merge Retry Next Carrier And Rows').parameters.numberInputs, 2)],
  ['next planner receives matching summary rows', () => assert.equal(node('Read Next Retry Summary Rows').parameters.dataTableId.value, 'summary_requests_v3')],
  ['same-key clean canonical rereads direct rows before verification', () => assert.deepEqual(new Set(targets('Route Next Retry Manual Review', 1)), new Set(['Re-read Ready Next Retry Attempt Rows', 'Merge Ready Next Retry Plan And Reread']))],
  ['same-key none canonical uses reconciliation mutations', () => assert.deepEqual(targets('Route Next Retry Reconcile', 0), ['Carry Next Retry Reconcile Mutations'])],
  ['same-key multiple canonical conflict uses the freeze mutation', () => assert.ok(targets('Carry Next Retry Freeze Mutations').includes('Freeze Next Retry Checkpoint Conflict Exact'))],
  ['reconciliation mutations use an exact CAS update', () => assert.equal(node('Reconcile Next Retry Attempt Exact').parameters.matchType, 'allConditions')],
  ['reconciliation rereads after every mutation batch', () => assert.deepEqual(targets('Limit Next Retry Reconciliation'), ['Re-read Reconcile Next Retry Attempt Rows'])],
  ['checkpoint freeze rereads after every mutation batch', () => assert.deepEqual(targets('Limit Next Retry Freeze'), ['Re-read Freeze Next Retry Attempt Rows'])],
  ['manual checkpoint terminal has no old-transition edge', () => assert.deepEqual(targets('Verify Next Retry Reconciliation'), ['Tag Plan Auto Retry Old Transition'])],
  ['old transition is planned from a verified next canonical', () => assert.equal(node('Plan Auto Retry Old Transition').parameters.jsCode, '__EXTERNAL_FILE__://nodes/Plan_Repairs/jsCode.js')],
  ['old transition exact update is limited before reread', () => assert.deepEqual(targets('Transition Old Retry Materialized Exact'), ['Limit Old Retry Transition'])],
  ['old verifier is before final dispatch reread', () => assert.deepEqual(targets('Verify Auto Retry Old Transition'), ['Re-read Next Before Retry Dispatch'])],
  ['retry attempt three has no materialization helper path', () => assert.throws(() => planRetry(attempt({ attempt: 3 })), /terminal/)],
  ['verifier implementations contain no historical run lookup', () => assert.doesNotMatch(fs.readFileSync(path.join(workflowDir, 'nodes/Plan_Repairs/jsCode.js'), 'utf8'), /\$runIndex|\.isExecuted/)],
]) test(`Task10 retry topology: ${name}`, check);

test('D3 retry postclaim segment has no named carrier lookup or Runtime Gates', () => {
  const retryNames = [
    'Plan Auto Retry Old Transition', 'Transition Old Retry Materialized Exact',
    'Limit Old Retry Transition', 'Re-read Old Retry Transition', 'Re-read Next Retry Transition',
    'Merge Old And Next Retry Rereads', 'Merge Retry Old Carrier And Rereads',
    'Verify Auto Retry Old Transition', 'Re-read Next Before Retry Dispatch',
    'Preflight Canonical Next Retry Dispatch', 'Dispatch Canonical Next Retry Attempt',
  ];
  const segment = JSON.stringify(retryNames.map(node));
  assert.doesNotMatch(segment, /\$\('Carry Retry Claim Plan'\)|Runtime_Gates/);
});

test('D3 old transition carrier directly fans out to the exact update and merge input zero', () => {
  assert.deepEqual(new Set(targets('Plan Auto Retry Old Transition')), new Set([
    'Transition Old Retry Materialized Exact', 'Merge Retry Old Carrier And Rereads',
  ]));
  assert.equal(workflow.connections['Plan Auto Retry Old Transition'].main[0]
    .find(({ node: target }) => target === 'Merge Retry Old Carrier And Rereads').index, 0);
});

test('D3 clean ready next rows are reread and appended with their stable plan carrier before old planning', () => {
  const merge = node('Merge Ready Next Retry Plan And Reread');
  assert.equal(merge.parameters.mode, 'append');
  assert.equal(merge.parameters.numberInputs, 2);
  assert.equal(workflow.connections['Route Next Retry Manual Review'].main[1]
    .find(({ node: target }) => target === merge.name).index, 0);
  assert.equal(workflow.connections['Re-read Ready Next Retry Attempt Rows'].main[0][0].index, 1);
  assert.deepEqual(targets(merge.name), ['Tag Verify Next Retry Ready']);
  assert.deepEqual(targets('Tag Verify Next Retry Ready'), ['Verify Next Retry Reconciliation']);
});

test('D3 old transition update reads every CAS and desired value from its direct carrier', () => {
  const transition = node('Transition Old Retry Materialized Exact');
  const serialized = JSON.stringify(transition.parameters);
  assert.match(serialized, /\$json\.transition\.filters\.id/);
  assert.match(serialized, /\$json\.transition\.filters\.retryLeaseOwner/);
  assert.match(serialized, /\$json\.transition\.desired\.manualReviewResolution/);
  assert.doesNotMatch(serialized, /\$\('/);
});

test('D3 old reread is gated by Limit 1 and next reread derives the verified resolution link', () => {
  assert.deepEqual(targets('Limit Old Retry Transition'), ['Re-read Old Retry Transition']);
  assert.deepEqual(new Set(targets('Re-read Old Retry Transition')), new Set([
    'Re-read Next Retry Transition', 'Merge Old And Next Retry Rereads',
  ]));
  assert.equal(node('Re-read Next Retry Transition').parameters.filters.conditions[0].keyValue,
    "={{ $json.manualReviewResolution.slice('retry_created:'.length) }}");
});

test('D3 old and next rereads use a two-input append merge with explicit indices', () => {
  const merge = node('Merge Old And Next Retry Rereads');
  assert.equal(merge.parameters.mode, 'append');
  assert.equal(merge.parameters.numberInputs, 2);
  assert.equal(workflow.connections['Re-read Old Retry Transition'].main[0]
    .find(({ node: target }) => target === merge.name).index, 0);
  assert.equal(workflow.connections['Re-read Next Retry Transition'].main[0][0].index, 1);
});

test('D3 combined rereads append to the direct transition carrier with explicit indices', () => {
  const merge = node('Merge Retry Old Carrier And Rereads');
  assert.equal(merge.parameters.mode, 'append');
  assert.equal(merge.parameters.numberInputs, 2);
  assert.equal(workflow.connections['Plan Auto Retry Old Transition'].main[0]
    .find(({ node: target }) => target === merge.name).index, 0);
  assert.equal(workflow.connections['Merge Old And Next Retry Rereads'].main[0][0].index, 1);
  assert.deepEqual(targets(merge.name), ['Tag Verify Auto Retry Old Transition']);
  assert.deepEqual(targets('Tag Verify Auto Retry Old Transition'), ['Verify Auto Retry Old Transition']);
});

test('D3 old verifier consumes direct rows by deterministic old and next attempt keys', () => {
  const code = fs.readFileSync(path.join(workflowDir, 'nodes/Plan_Repairs/jsCode.js'), 'utf8');
  assert.match(code, /plan\.transition\.filters\.attemptKey/);
  assert.match(code, /row\.attemptKey === plan\.nextAttemptKey/);
  assert.match(code, /verifyOldTransition\(oldRows, plan\.transition\)/);
  assert.match(code, /verifyNextRows\(nextRows, \{ action: 'ready', winnerRowID: plan\.canonicalNext\.id \}\)/);
});

test('D3 old verifier fails closed on zero old rows', () => {
  const old = attempt({ status: 'retry_materializing', retryLeaseOwner: 'repair', retryLeaseUntilIso: LATER });
  const transition = planAutoRetryOldTransition(old, `${LOGICAL}:2`, NOW);
  assert.throws(() => verifyOldTransition([], transition), /rows not found/);
});

test('D3 old verifier fails closed on a partial old transition', () => {
  const old = attempt({ status: 'retry_materializing', retryLeaseOwner: 'repair', retryLeaseUntilIso: LATER });
  const transition = planAutoRetryOldTransition(old, `${LOGICAL}:2`, NOW);
  assert.throws(() => verifyOldTransition([old], transition), /transition not verified/);
});

test('D3 old verifier fails closed on a replaced old canonical', () => {
  const old = attempt({ status: 'retry_materializing', retryLeaseOwner: 'repair', retryLeaseUntilIso: LATER });
  const transition = planAutoRetryOldTransition(old, `${LOGICAL}:2`, NOW);
  const replacement = attempt({ id: systemID('replacement'), status: 'retry_materialized', retryLeaseOwner: '', retryLeaseUntilIso: '', manualReviewResolution: `retry_created:${LOGICAL}:2` });
  assert.throws(() => verifyOldTransition([replacement], transition), /identity mismatch/);
});

test('D3 next verifier fails closed on zero, partial, and mismatched next rows', () => {
  const canonical = attempt({ attempt: 2, id: systemID('next'), attemptKey: `${LOGICAL}:2`, status: 'queued', canonicalRowID: String(systemID('next')) });
  assert.throws(() => verifyNextRows([], { action: 'ready', winnerRowID: systemID('next') }), /rows not found/);
  assert.throws(() => verifyNextRows([{ ...canonical, reconciliationStatus: 'duplicate', canonicalRowID: String(systemID('other')) }], { action: 'ready', winnerRowID: systemID('next') }), /exactly one canonical/);
  assert.throws(() => verifyNextRows([canonical], { action: 'ready', winnerRowID: systemID('other') }), /winner mismatch/);
});

test('D3 old transition requires the exact retry resolution and cleared lease', () => {
  const old = attempt({ status: 'retry_materializing', retryLeaseOwner: 'repair', retryLeaseUntilIso: LATER });
  const transition = planAutoRetryOldTransition(old, `${LOGICAL}:2`, NOW);
  const applied = attempt({ status: 'retry_materialized', retryLeaseOwner: '', retryLeaseUntilIso: '', manualReviewResolution: `retry_created:${LOGICAL}:2` });
  assert.equal(verifyOldTransition([applied], transition).action, 'verified');
  assert.throws(() => verifyOldTransition([{ ...applied, manualReviewResolution: `retry_created:${LOGICAL}:3` }], transition), /resolution link mismatch/);
  assert.throws(() => verifyOldTransition([{ ...applied, retryLeaseUntilIso: LATER }], transition), /lease was not cleared/);
});

test('D3 dispatcher preflight rereads after old verification and emits only attemptKey to an async sink', () => {
  const preflight = node('Preflight Canonical Next Retry Dispatch');
  const call = node('Dispatch Canonical Next Retry Attempt');
  assert.deepEqual(targets('Verify Auto Retry Old Transition'), ['Re-read Next Before Retry Dispatch']);
  assert.match(preflight.parameters.jsCode, /exactly one canonical/);
  assert.match(preflight.parameters.jsCode, /dispatchLeaseOwner !== ''/);
  assert.equal(call.parameters.options.waitForSubWorkflow, false);
  assert.deepEqual(Object.keys(call.parameters.workflowInputs.value), ['attemptKey']);
  assert.deepEqual(targets(call.name), ['Repair Side Effect Sink']);
});

function bounded(className, rows) {
  return planBoundedClass(className, rows, NOW);
}

test('bounded planner sorts candidates by strict createdAt and id', () => {
  const rows = [
    attempt({ id: systemID('row-z'), status: 'waiting_callback', callbackDeadlineAtIso: NOW }),
    attempt({ id: systemID('row-a'), status: 'waiting_callback', callbackDeadlineAtIso: NOW }),
  ];
  assert.deepEqual(bounded('callback_deadline', rows).map(({ locator }) => locator.id), [systemID('row-z'), systemID('row-a')]);
});

test('bounded planner emits exactly fifty eligible candidates without cap error', () => {
  const rows = Array.from({ length: 50 }, (_, index) => attempt({
    id: `row-${String(index).padStart(2, '0')}`, status: 'waiting_callback', callbackDeadlineAtIso: NOW,
  }));
  const result = bounded('callback_deadline', rows);
  assert.equal(result.length, 50);
  assert.ok(result.every((item) => item.kind === 'candidate'));
});

test('bounded planner stops the fifty-first candidate and emits a masked cap error', () => {
  const rows = Array.from({ length: 51 }, (_, index) => attempt({
    id: `row-${String(index).padStart(2, '0')}`, status: 'waiting_callback', callbackDeadlineAtIso: NOW,
  }));
  const result = bounded('callback_deadline', rows);
  assert.equal(result.filter((item) => item.kind === 'candidate').length, 50);
  const error = result.find((item) => item.kind === 'cap_error');
  assert.equal(error.count, 51);
  assert.equal(error.errorCode, 'repair_scan_cap_exceeded');
  assert.doesNotMatch(error.messageMasked, /row-50/);
});

test('cap errors use the exact fourteen-column masked error contract', () => {
  const error = planRepairCapError('callback_deadline', 51, NOW);
  assert.deepEqual(Object.keys(error).slice(1, 15), [
    'errorKey', 'component', 'reconciliationStatus', 'canonicalRowID', 'requestKey',
    'logicalJobKey', 'attemptKey', 'executionID', 'workflowName', 'nodeName',
    'errorCode', 'messageMasked', 'retryable', 'createdAtIso',
  ]);
  assert.equal(error.reconciliationStatus, 'pending');
  assert.equal(error.canonicalRowID, '');
  assert.equal(error.retryable, false);
});

for (const [repairClass, factory] of [
  ['expired_dispatch_lease', () => attempt({ status: 'dispatching', dispatchLeaseOwner: 'dead', dispatchLeaseUntilIso: NOW })],
  ['callback_deadline', () => attempt({ status: 'waiting_callback', callbackDeadlineAtIso: NOW })],
  ['retry_materialization', () => attempt({ status: 'retry_pending', nextRetryAtIso: NOW })],
  ['creation_lease', () => request({ status: 'creating', creationLeaseOwner: 'dead', creationLeaseUntilIso: NOW })],
  ['summary_lease', () => request({ status: 'ready', leaseOwner: '', leaseUntilIso: '' })],
  ['presentation_lease', () => attempt({ status: 'completed', presentationStatus: 'retry_pending', presentationNextRetryAtIso: NOW })],
  ['duplicate_deterministic_keys', () => attempt({ status: 'queued' })],
]) {
  test(`${repairClass} bounded predicate excludes manual review`, () => {
    const row = factory();
    assert.deepEqual(bounded(repairClass, [{ ...row, status: 'manual_review', manualReviewAtIso: NOW }]), []);
  });
}

for (const [repairClass, row] of [
  ['expired_dispatch_lease', attempt({ status: 'dispatching', dispatchLeaseOwner: 'dead', dispatchLeaseUntilIso: LATER })],
  ['callback_deadline', attempt({ status: 'waiting_callback', callbackDeadlineAtIso: LATER })],
  ['retry_materialization', attempt({ status: 'retry_pending', nextRetryAtIso: LATER })],
  ['creation_lease', request({ status: 'creating', creationLeaseOwner: 'live', creationLeaseUntilIso: LATER })],
  ['presentation_lease', attempt({ status: 'completed', presentationStatus: 'presenting', presentationLeaseOwner: 'live', presentationLeaseUntilIso: LATER })],
]) {
  test(`${repairClass} bounded predicate excludes active or future rows`, () => {
    assert.deepEqual(bounded(repairClass, [row]), []);
  });
}

test('bounded predicates fail closed on malformed due dates', () => {
  assert.deepEqual(bounded('callback_deadline', [attempt({ status: 'waiting_callback', callbackDeadlineAtIso: 'bad' })]), []);
  assert.deepEqual(bounded('retry_materialization', [attempt({ status: 'retry_pending', nextRetryAtIso: 'bad' })]), []);
  assert.deepEqual(bounded('presentation_lease', [attempt({ status: 'completed', presentationStatus: 'retry_pending', presentationNextRetryAtIso: 'bad' })]), []);
});

test('each class is independently bounded', () => {
  const callbacks = Array.from({ length: 51 }, (_, index) => attempt({ id: `cb-${index}`, status: 'waiting_callback', callbackDeadlineAtIso: NOW }));
  const dispatch = attempt({ id: systemID('dispatch'), status: 'dispatching', dispatchLeaseOwner: 'dead', dispatchLeaseUntilIso: NOW });
  assert.equal(bounded('callback_deadline', callbacks).filter((item) => item.kind === 'candidate').length, 50);
  assert.equal(bounded('expired_dispatch_lease', [dispatch]).filter((item) => item.kind === 'candidate').length, 1);
});

test('expired dispatch runtime plan fails closed for active leases and never resends', () => {
  assert.throws(() => planExpiredDispatchLease(attempt({ status: 'dispatching', dispatchLeaseOwner: 'live', dispatchLeaseUntilIso: LATER }), NOW), /not expired/);
  assert.equal(planExpiredDispatchLease(attempt({ status: 'dispatching', dispatchLeaseOwner: 'dead', dispatchLeaseUntilIso: NOW }), NOW).neverAutoResend, true);
});

for (const attemptNumber of [1, 2, 3]) {
  test(`callback bounded runtime preserves attempt ${attemptNumber} deadline table`, () => {
    const plan = planCallbackDeadline(attempt({ attempt: attemptNumber, status: 'waiting_callback', callbackDeadlineAtIso: NOW }), NOW);
    assert.equal(plan.status, attemptNumber === 3 ? 'timed_out' : 'retry_pending');
    assert.equal(plan.nextRetryAtIso, attemptNumber === 1 ? '2026-08-24T00:01:00.000Z' : attemptNumber === 2 ? '2026-08-24T00:05:00.000Z' : '');
  });
}

test('Subtask E: bounded planner on exact 50 items produces 50 candidates and zero cap error', () => {
  const rows = Array.from({ length: 50 }, (_, index) => attempt({
    id: `row-${String(index).padStart(2, '0')}`,
    status: 'waiting_callback',
    callbackDeadlineAtIso: NOW,
  }));
  const result = bounded('callback_deadline', rows);
  assert.equal(result.length, 50);
  assert.equal(result.filter((r) => r.kind === 'candidate').length, 50);
  assert.equal(result.filter((r) => r.kind === 'cap_error').length, 0);
});

test('Subtask E: bounded planner on 51 items produces exactly 50 candidates and 1 cap error for item 51', () => {
  const rows = Array.from({ length: 51 }, (_, index) => attempt({
    id: `row-${String(index).padStart(2, '0')}`,
    status: 'waiting_callback',
    callbackDeadlineAtIso: NOW,
  }));
  const result = bounded('callback_deadline', rows);
  assert.equal(result.length, 51);
  const candidates = result.filter((r) => r.kind === 'candidate');
  const capErrors = result.filter((r) => r.kind === 'cap_error');
  assert.equal(candidates.length, 50);
  assert.equal(capErrors.length, 1);
  assert.equal(capErrors[0].count, 51);
  assert.equal(capErrors[0].cap, 50);
});

test('Subtask E: bounded planner on 100 items produces exactly 50 candidates and 1 cap error with count 100', () => {
  const rows = Array.from({ length: 100 }, (_, index) => attempt({
    id: `row-${String(index).padStart(3, '0')}`,
    status: 'waiting_callback',
    callbackDeadlineAtIso: NOW,
  }));
  const result = bounded('callback_deadline', rows);
  assert.equal(result.filter((r) => r.kind === 'candidate').length, 50);
  const capErrors = result.filter((r) => r.kind === 'cap_error');
  assert.equal(capErrors.length, 1);
  assert.equal(capErrors[0].count, 100);
});

test('Subtask E: item 51 and beyond never receive mutation plan, carrier, or dispatch call', () => {
  const rows = Array.from({ length: 55 }, (_, index) => attempt({
    id: `disp-${String(index).padStart(2, '0')}`,
    status: 'dispatching',
    dispatchLeaseOwner: 'dead-exec',
    dispatchLeaseUntilIso: NOW,
  }));
  const result = bounded('expired_dispatch_lease', rows);
  const candidateIds = new Set(result.filter((r) => r.kind === 'candidate').map((r) => r.locator.id));
  assert.equal(candidateIds.size, 50);
  for (let index = 50; index < 55; index += 1) {
    assert.equal(candidateIds.has(`disp-${String(index).padStart(2, '0')}`), false);
  }
});

test('Subtask E: cap error matches exact 14-field SCHEMA_KEYS without credentials, lease, or raw payload', () => {
  const capErr = planRepairCapError('expired_dispatch_lease', 55, NOW);
  assert.deepEqual(SCHEMA_KEYS, [
    'errorKey', 'component', 'reconciliationStatus', 'canonicalRowID', 'requestKey',
    'logicalJobKey', 'attemptKey', 'executionID', 'workflowName', 'nodeName',
    'errorCode', 'messageMasked', 'retryable', 'createdAtIso',
  ]);
  for (const key of SCHEMA_KEYS) {
    assert.ok(Object.hasOwn(capErr, key), `Missing schema key ${key}`);
  }
  assert.equal(capErr.component, 'automation_retry_and_repair_v3');
  assert.equal(capErr.reconciliationStatus, 'pending');
  assert.equal(capErr.canonicalRowID, '');
  assert.equal(capErr.errorCode, 'repair_scan_cap_exceeded');
  assert.equal(capErr.retryable, false);
  assert.equal(capErr.createdAtIso, NOW);
  assert.doesNotMatch(JSON.stringify(capErr), /leaseOwner|leaseUntil|token|credential|headers|stack/i);
});

test('Subtask E: cap error errorKey is deterministic and changes with repairClass, count, or nowIso', () => {
  const e1 = planRepairCapError('expired_dispatch_lease', 51, NOW);
  const e2 = planRepairCapError('expired_dispatch_lease', 51, NOW);
  const e3 = planRepairCapError('callback_deadline', 51, NOW);
  const e4 = planRepairCapError('expired_dispatch_lease', 52, NOW);
  const e5 = planRepairCapError('expired_dispatch_lease', 51, LATER);
  assert.equal(e1.errorKey, e2.errorKey);
  assert.notEqual(e1.errorKey, e3.errorKey);
  assert.notEqual(e1.errorKey, e4.errorKey);
  assert.notEqual(e1.errorKey, e5.errorKey);
});

test('Subtask E: all seven classes strictly exclude manual_review rows', () => {
  const manualAttempt = (overrides = {}) => attempt({ status: 'manual_review', manualReviewReason: 'some_reason', manualReviewAtIso: NOW, ...overrides });
  const manualRequest = (overrides = {}) => request({ status: 'manual_review', manualReviewReason: 'some_reason', manualReviewAtIso: NOW, ...overrides });

  assert.deepEqual(bounded('expired_dispatch_lease', [manualAttempt({ dispatchLeaseOwner: 'd', dispatchLeaseUntilIso: NOW })]), []);
  assert.deepEqual(bounded('callback_deadline', [manualAttempt({ callbackDeadlineAtIso: NOW })]), []);
  assert.deepEqual(bounded('retry_materialization', [manualAttempt({ nextRetryAtIso: NOW })]), []);
  assert.deepEqual(bounded('creation_lease', [manualRequest({ creationLeaseOwner: 'd', creationLeaseUntilIso: NOW })]), []);
  assert.deepEqual(bounded('summary_lease', [manualRequest({ leaseOwner: 'd', leaseUntilIso: NOW })]), []);
  assert.deepEqual(bounded('presentation_lease', [manualAttempt({ presentationStatus: 'retry_pending', presentationNextRetryAtIso: NOW })]), []);
  assert.deepEqual(bounded('duplicate_deterministic_keys', [manualAttempt()]), []);
});

test('Subtask E: all due predicates exclude future timestamps', () => {
  assert.deepEqual(bounded('expired_dispatch_lease', [attempt({ status: 'dispatching', dispatchLeaseOwner: 'd', dispatchLeaseUntilIso: LATER })]), []);
  assert.deepEqual(bounded('callback_deadline', [attempt({ status: 'waiting_callback', callbackDeadlineAtIso: LATER })]), []);
  assert.deepEqual(bounded('retry_materialization', [attempt({ status: 'retry_pending', nextRetryAtIso: LATER })]), []);
  assert.deepEqual(bounded('creation_lease', [request({ status: 'creating', creationLeaseOwner: 'live', creationLeaseUntilIso: LATER })]), []);
  assert.deepEqual(bounded('summary_lease', [request({ status: 'summary_dispatching', leaseOwner: 'live', leaseUntilIso: LATER })]), []);
  assert.deepEqual(bounded('summary_lease', [request({ status: 'summary_retry_pending', nextRetryAtIso: LATER })]), []);
  assert.deepEqual(bounded('presentation_lease', [attempt({ status: 'completed', presentationStatus: 'retry_pending', presentationNextRetryAtIso: LATER })]), []);
  assert.deepEqual(bounded('presentation_lease', [attempt({ status: 'completed', presentationStatus: 'presenting', presentationLeaseOwner: 'live', presentationLeaseUntilIso: LATER })]), []);
});

test('Subtask E: all due predicates exclude active leases', () => {
  const activeDispatch = attempt({ status: 'dispatching', dispatchLeaseOwner: 'live', dispatchLeaseUntilIso: LATER });
  assert.deepEqual(bounded('expired_dispatch_lease', [activeDispatch]), []);
  const activeRetry = attempt({ status: 'retry_materializing', retryLeaseOwner: 'live', retryLeaseUntilIso: LATER });
  assert.deepEqual(bounded('retry_materialization', [activeRetry]), []);
  const activeCreation = request({ status: 'creating', creationLeaseOwner: 'live', creationLeaseUntilIso: LATER });
  assert.deepEqual(bounded('creation_lease', [activeCreation]), []);
  const activeSummary = request({ status: 'summary_dispatching', leaseOwner: 'live', leaseUntilIso: LATER });
  assert.deepEqual(bounded('summary_lease', [activeSummary]), []);
  const activePresentation = attempt({ status: 'completed', presentationStatus: 'presenting', presentationLeaseOwner: 'live', presentationLeaseUntilIso: LATER });
  assert.deepEqual(bounded('presentation_lease', [activePresentation]), []);
});

test('Subtask E: all due predicates fail closed on invalid or malformed timestamp strings', () => {
  for (const badTime of ['', '   ', 'not-a-date', '2026-08-24 00:00:00', '1787364000']) {
    assert.deepEqual(bounded('expired_dispatch_lease', [attempt({ status: 'dispatching', dispatchLeaseOwner: 'd', dispatchLeaseUntilIso: badTime })]), []);
    assert.deepEqual(bounded('callback_deadline', [attempt({ status: 'waiting_callback', callbackDeadlineAtIso: badTime })]), []);
    assert.deepEqual(bounded('retry_materialization', [attempt({ status: 'retry_pending', nextRetryAtIso: badTime })]), []);
    assert.deepEqual(bounded('creation_lease', [request({ status: 'creating', creationLeaseOwner: 'd', creationLeaseUntilIso: badTime })]), []);
    assert.deepEqual(bounded('summary_lease', [request({ status: 'summary_retry_pending', nextRetryAtIso: badTime })]), []);
    assert.deepEqual(bounded('presentation_lease', [attempt({ status: 'completed', presentationStatus: 'retry_pending', presentationNextRetryAtIso: badTime })]), []);
  }
});

test('Subtask E: class independence: overflow in one class leaves other classes at their true candidate counts', () => {
  const cbRows = Array.from({ length: 60 }, (_, index) => attempt({ id: `cb-${index}`, status: 'waiting_callback', callbackDeadlineAtIso: NOW }));
  const dispRows = [
    attempt({ id: systemID('disp-1'), status: 'dispatching', dispatchLeaseOwner: 'd1', dispatchLeaseUntilIso: NOW }),
    attempt({ id: systemID('disp-2'), status: 'dispatching', dispatchLeaseOwner: 'd2', dispatchLeaseUntilIso: NOW }),
  ];
  const retryRows = Array.from({ length: 10 }, (_, index) => attempt({ id: `ret-${index}`, status: 'retry_pending', nextRetryAtIso: NOW }));

  const cbResult = bounded('callback_deadline', cbRows);
  const dispResult = bounded('expired_dispatch_lease', dispRows);
  const retResult = bounded('retry_materialization', retryRows);

  assert.equal(cbResult.filter((r) => r.kind === 'candidate').length, 50);
  assert.equal(cbResult.filter((r) => r.kind === 'cap_error').length, 1);
  assert.equal(dispResult.filter((r) => r.kind === 'candidate').length, 2);
  assert.equal(dispResult.filter((r) => r.kind === 'cap_error').length, 0);
  assert.equal(retResult.filter((r) => r.kind === 'candidate').length, 10);
  assert.equal(retResult.filter((r) => r.kind === 'cap_error').length, 0);
});

test('Subtask E: expired dispatch runtime plan sets manual_review with cleared dispatch lease and neverAutoResend', () => {
  const row = attempt({ status: 'dispatching', dispatchLeaseOwner: 'dead-owner', dispatchLeaseUntilIso: NOW });
  const plan = planExpiredDispatchLease(row, NOW);
  assert.equal(plan.action, 'manual_review');
  assert.equal(plan.repairClass, 'expired_dispatch_lease');
  assert.equal(plan.neverAutoResend, true);
  assert.deepEqual(plan.desired, {
    status: 'manual_review',
    manualReviewReason: 'dispatch_lease_expired_outcome_unknown',
    manualReviewAtIso: NOW,
    dispatchLeaseOwner: '',
    dispatchLeaseUntilIso: '',
    updatedAtIso: NOW,
  });
  assert.deepEqual(plan.filters, {
    id: row.id,
    attemptKey: row.attemptKey,
    status: 'dispatching',
    reconciliationStatus: 'canonical',
    canonicalRowID: String(row.id),
    dispatchLeaseOwner: 'dead-owner',
    dispatchLeaseUntilIso: NOW,
  });
});

test('Subtask E: expired dispatch fails closed if dispatch lease is not yet expired', () => {
  const active = attempt({ status: 'dispatching', dispatchLeaseOwner: 'live-owner', dispatchLeaseUntilIso: LATER });
  assert.throws(() => planExpiredDispatchLease(active, NOW), /Dispatch lease is not expired/);
});

test('Subtask E: callback deadline attempt 1 produces retry_pending with +1 minute delay', () => {
  const row = attempt({ attempt: 1, status: 'waiting_callback', callbackDeadlineAtIso: NOW });
  const plan = planCallbackDeadline(row, NOW);
  assert.equal(plan.action, 'callback_deadline');
  assert.equal(plan.status, 'retry_pending');
  assert.equal(plan.errorCode, 'callback_deadline_exceeded');
  assert.equal(plan.nextRetryAtIso, '2026-08-24T00:01:00.000Z');
  assert.deepEqual(plan.filters, {
    id: row.id,
    attemptKey: row.attemptKey,
    status: 'waiting_callback',
    reconciliationStatus: 'canonical',
    canonicalRowID: String(row.id),
    callbackDeadlineAtIso: NOW,
  });
});

test('Subtask E: callback deadline attempt 2 produces retry_pending with +5 minute delay', () => {
  const row = attempt({ attempt: 2, status: 'waiting_callback', callbackDeadlineAtIso: NOW });
  const plan = planCallbackDeadline(row, NOW);
  assert.equal(plan.action, 'callback_deadline');
  assert.equal(plan.status, 'retry_pending');
  assert.equal(plan.errorCode, 'callback_deadline_exceeded');
  assert.equal(plan.nextRetryAtIso, '2026-08-24T00:05:00.000Z');
});

test('Subtask E: callback deadline attempt 3 produces timed_out with no nextRetryAtIso', () => {
  const row = attempt({ attempt: 3, status: 'waiting_callback', callbackDeadlineAtIso: NOW });
  const plan = planCallbackDeadline(row, NOW);
  assert.equal(plan.action, 'callback_deadline_exhausted');
  assert.equal(plan.status, 'timed_out');
  assert.equal(plan.errorCode, 'callback_deadline_exceeded');
  assert.equal(plan.nextRetryAtIso, '');
  assert.equal(plan.desired.status, 'timed_out');
  assert.equal(plan.desired.nextRetryAtIso, '');
});

test('Subtask E: callback deadline fails closed if deadline is in the future', () => {
  const future = attempt({ attempt: 1, status: 'waiting_callback', callbackDeadlineAtIso: LATER });
  assert.throws(() => planCallbackDeadline(future, NOW), /Callback deadline is not due/);
});

test('Subtask E: cap error absent rows plan inserts pending error', () => {
  const candidate = planRepairCapError('expired_dispatch_lease', 51, NOW);
  const plan = planCapErrorRows([], candidate);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'insert_pending');
  assert.equal(plan[0].errorKey, candidate.errorKey);
  assert.equal(plan[0].reconciliationStatus, 'pending');
});

test('Subtask E: cap error pending insert canonicalization elects earliest row as canonical and non-winners as duplicate', () => {
  const candidate = planRepairCapError('expired_dispatch_lease', 51, NOW);
  const row1 = { ...candidate, id: systemID('err-row-a'), createdAt: NOW, reconciliationStatus: 'pending', canonicalRowID: '' };
  const row2 = { ...candidate, id: systemID('err-row-b'), createdAt: LATER, reconciliationStatus: 'pending', canonicalRowID: '' };
  const mutations = planPendingCapErrorCanonical([row2, row1]);
  assert.equal(mutations.length, 2);
  const m1 = mutations.find((m) => m.id === systemID('err-row-a'));
  const m2 = mutations.find((m) => m.id === systemID('err-row-b'));
  assert.equal(m1.desiredReconciliationStatus, 'canonical');
  assert.equal(m1.desiredCanonicalRowID, String(systemID('err-row-a')));
  assert.equal(m2.desiredReconciliationStatus, 'duplicate');
  assert.equal(m2.desiredCanonicalRowID, String(systemID('err-row-a')));
});

test('Subtask E: cap error single existing canonical plans insert duplicate error', () => {
  const candidate = planRepairCapError('expired_dispatch_lease', 51, NOW);
  const canonical = { ...candidate, id: systemID('err-canon-1'), createdAt: NOW, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('err-canon-1')) };
  const plan = planCapErrorRows([canonical], candidate);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'insert_duplicate');
  assert.equal(plan[0].canonicalRowID, String(systemID('err-canon-1')));
});

test('Subtask E: cap error multiple canonicals plans reconciliation of losers to duplicate', () => {
  const candidate = planRepairCapError('expired_dispatch_lease', 51, NOW);
  const c1 = { ...candidate, id: systemID('err-a'), createdAt: NOW, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('err-a')) };
  const c2 = { ...candidate, id: systemID('err-b'), createdAt: LATER, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('err-b')) };
  const plan = planCapErrorRows([c1, c2], candidate);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'reconcile');
  assert.equal(plan[0].id, systemID('err-b'));
  assert.equal(plan[0].desiredReconciliationStatus, 'duplicate');
  assert.equal(plan[0].desiredCanonicalRowID, String(systemID('err-a')));
});

test('Subtask E: cap error immutable payload drift fails closed with error', () => {
  const candidate = planRepairCapError('expired_dispatch_lease', 51, NOW);
  const drifted = { ...candidate, id: systemID('err-a'), createdAt: NOW, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('err-a')), messageMasked: 'tampered' };
  assert.throws(() => planCapErrorRows([drifted], candidate), /immutable masked error payload drift/);
});

test('Subtask E: cap error verifier fails closed on invalid canonical or duplicate linkage', () => {
  const validCanonical = { id: systemID('err-a'), errorKey: 'err:v1:test', reconciliationStatus: 'canonical', canonicalRowID: String(systemID('err-a')) };
  const validDuplicate = { id: systemID('err-b'), errorKey: 'err:v1:test', reconciliationStatus: 'duplicate', canonicalRowID: String(systemID('err-a')) };
  assert.deepEqual(verifyCapErrorReconciliation([validCanonical, validDuplicate]), [{ canonicalRowID: String(systemID('err-a')) }]);
  assert.deepEqual(verifyDuplicateCapError([validCanonical, validDuplicate]), [{ errorKey: 'err:v1:test', canonicalRowID: String(systemID('err-a')) }]);

  assert.throws(() => verifyCapErrorReconciliation([]), /error reconciliation verification failed/);
  assert.throws(() => verifyCapErrorReconciliation([{ ...validCanonical, canonicalRowID: String(systemID('wrong')) }]), /error reconciliation verification failed/);
  assert.throws(() => verifyCapErrorReconciliation([validCanonical, { ...validDuplicate, canonicalRowID: String(systemID('wrong')) }]), /error reconciliation verification failed/);
  assert.throws(() => verifyDuplicateCapError([]), /duplicate error verification failed/);
  assert.throws(() => verifyDuplicateCapError([validCanonical, { ...validDuplicate, reconciliationStatus: 'pending' }]), /duplicate error verification failed/);
});

test('Subtask E: all seven bounded routes in workflow connect candidate to Limit 50 and overflow to cap error path', () => {
  const routerNames = [
    'Route Bounded Expired Dispatch',
    'Route Bounded Callback Deadline',
    'Route Bounded Retry Materialization',
    'Route Bounded Creation Lease',
    'Route Bounded Summary Missed Event',
    'Route Bounded Presentation Repair',
    'Route Bounded Duplicate Key',
  ];
  for (const router of routerNames) {
    const candidateTargets = targets(router, 0);
    const overflowTargets = targets(router, 1);
    assert.equal(candidateTargets.length, 1, `${router} candidate target`);
    assert.match(candidateTargets[0], /^Limit .* Candidates 50$/, `${router} candidate limit target`);
    assert.ok(overflowTargets.includes('Read Cap Error Rows'), `${router} overflow to Read Cap Error Rows`);
    assert.ok(overflowTargets.includes('Merge Cap Error Carrier And Rows'), `${router} overflow to Merge Cap Error Carrier And Rows`);
  }
});

test('Subtask E: workflow contains exact 14-column writes for automation_errors_v3 with allConditions and Limit 1', () => {
  const errorWrites = workflow.nodes.filter(({ type, parameters }) => type === 'n8n-nodes-base.dataTable' && parameters.dataTableId?.value === 'automation_errors_v3' && ['insert', 'update'].includes(parameters.operation));
  assert.ok(errorWrites.length >= 4, `Expected at least 4 error writes, found ${errorWrites.length}`);
  for (const write of errorWrites) {
    if (write.parameters.operation === 'insert') {
      assert.deepEqual(Object.keys(write.parameters.columns.value), SCHEMA_KEYS, write.name);
    } else {
      assert.deepEqual(Object.keys(write.parameters.columns.value), ['reconciliationStatus', 'canonicalRowID'], write.name);
      assert.equal(write.parameters.matchType, 'allConditions', write.name);
    }
    assert.equal(write.alwaysOutputData, true, write.name);
    const [limitName] = targets(write.name);
    assert.match(limitName || '', /^Limit /, write.name);
    assert.equal(node(limitName).parameters.maxItems, 1, write.name);
  }
});

test('Subtask F: creation repair reconstructs exact Task8 typed input with all 6 fields', () => {
  const req = request({
    status: 'creating',
    creationLeaseOwner: '',
    creationLeaseUntilIso: '',
  });
  const plan = planCreationRepair(req, [], NOW);
  assert.equal(plan.action, 'resume_creation');
  assert.equal(plan.targetWorkflow, 'SummaryOrchV3A01');
  assert.deepEqual(Object.keys(plan.input), ['requestKey', 'requestType', 'orderedStreams', 'existingDialogues', 'channel', 'threadTS']);
  assert.equal(plan.input.requestKey, KEY);
  assert.equal(plan.input.channel, CHANNEL);
  assert.equal(Array.isArray(plan.input.orderedStreams), true);
  assert.equal(plan.input.orderedStreams.length, 1);
});

test('Subtask F: creation repair returns noop if request is already accepted', () => {
  for (const st of ['waiting_stt', 'ready', 'summary_dispatching', 'summary_retry_pending', 'completed', 'failed', 'creation_failed']) {
    const req = request({ status: st });
    const plan = planCreationRepair(req, [], NOW);
    assert.equal(plan.action, 'noop');
    assert.equal(plan.reason, 'request_already_accepted');
  }
});

test('Subtask F: creation repair returns noop if creation lease is active', () => {
  const req = request({
    status: 'creating',
    creationLeaseOwner: 'active-worker',
    creationLeaseUntilIso: LATER,
  });
  const plan = planCreationRepair(req, [], NOW);
  assert.equal(plan.action, 'noop');
  assert.equal(plan.reason, 'creation_lease_active');
});

test('Subtask F: creation repair succeeds if creation lease is empty or expired', () => {
  const emptyLease = request({ status: 'creating', creationLeaseOwner: '', creationLeaseUntilIso: '' });
  assert.equal(planCreationRepair(emptyLease, [], NOW).action, 'resume_creation');

  const expiredLease = request({ status: 'creating', creationLeaseOwner: 'old-worker', creationLeaseUntilIso: NOW });
  assert.equal(planCreationRepair(expiredLease, [], NOW).action, 'resume_creation');
});

test('Subtask F: creation repair fails closed on malformed orderedStreamsJson, invalid mode, or non-C0 channel', () => {
  assert.throws(() => planCreationRepair(request({ status: 'creating', orderedStreamsJson: 'invalid' }), [], NOW), /Invalid orderedStreamsJson/);
  assert.throws(() => planCreationRepair(request({ status: 'creating', channel: 'C0999999999' }), [], NOW), /Invalid request channel/);
  assert.throws(() => planCreationRepair(request({ status: 'creating', threadTS: 'bad-ts' }), [], NOW), /Invalid request threadTS/);
});

test('Subtask F: creation repair fails closed if expectedLogicalJobKeysJson does not match computed keys', () => {
  const mismatched = request({
    status: 'creating',
    expectedLogicalJobKeysJson: JSON.stringify(['wrong:key:1']),
  });
  assert.throws(() => planCreationRepair(mismatched, [], NOW), /Immutable expected keys mismatch/);
});

test('Subtask F: summary repair waiting_stt calls coordinator only when all logical jobs are terminal', () => {
  const req = request({ status: 'waiting_stt', leaseOwner: '', leaseUntilIso: '' });
  const completedAttempts = [
    attempt({ id: systemID('att-1'), attempt: 1, status: 'completed', dialogue: 'transcript text', canonicalRowID: String(systemID('att-1')) }),
  ];
  const plan = planSummaryLease(req, NOW, completedAttempts);
  assert.equal(plan.action, 'call_coordinator');
  assert.equal(plan.targetWorkflow, 'SummaryCoordV3A1');
  assert.deepEqual(plan.input, { requestKey: KEY });
});

test('Subtask F: summary repair waiting_stt returns noop when logical jobs are pending', () => {
  const req = request({ status: 'waiting_stt', leaseOwner: '', leaseUntilIso: '' });
  const pendingAttempts = [
    attempt({ id: systemID('att-1'), attempt: 1, status: 'waiting_callback', canonicalRowID: String(systemID('att-1')) }),
  ];
  const plan = planSummaryLease(req, NOW, pendingAttempts);
  assert.equal(plan.action, 'noop');
  assert.equal(plan.reason, 'waiting_stt_not_terminal');
});

test('Subtask F: summary repair ready calls coordinator when lease is empty or expired', () => {
  const emptyLease = request({ status: 'ready', leaseOwner: '', leaseUntilIso: '' });
  assert.equal(planSummaryLease(emptyLease, NOW).action, 'call_coordinator');

  const expiredLease = request({ status: 'ready', leaseOwner: 'dead-exec', leaseUntilIso: NOW });
  assert.equal(planSummaryLease(expiredLease, NOW).action, 'call_coordinator');
});

test('Subtask F: summary repair ready returns noop when lease is active', () => {
  const activeLease = request({ status: 'ready', leaseOwner: 'active-exec', leaseUntilIso: LATER });
  const plan = planSummaryLease(activeLease, NOW);
  assert.equal(plan.action, 'noop');
  assert.equal(plan.reason, 'summary_lease_active');
});

test('Subtask F: summary repair summary_retry_pending calls coordinator when retry is due and lease pair is empty', () => {
  const due = request({
    status: 'summary_retry_pending',
    nextRetryAtIso: NOW,
    leaseOwner: '',
    leaseUntilIso: '',
  });
  const plan = planSummaryLease(due, NOW);
  assert.equal(plan.action, 'call_coordinator');
  assert.equal(plan.targetWorkflow, 'SummaryCoordV3A1');
  assert.deepEqual(plan.input, { requestKey: KEY });
});

test('Subtask F: summary repair summary_retry_pending returns noop when retry is in future', () => {
  const future = request({
    status: 'summary_retry_pending',
    nextRetryAtIso: LATER,
    leaseOwner: '',
    leaseUntilIso: '',
  });
  const plan = planSummaryLease(future, NOW);
  assert.equal(plan.action, 'noop');
  assert.equal(plan.reason, 'summary_retry_not_due');
});

test('Subtask F: summary repair summary_retry_pending throws on malformed lease pair', () => {
  const badLease = request({
    status: 'summary_retry_pending',
    nextRetryAtIso: NOW,
    leaseOwner: 'stale-owner',
    leaseUntilIso: NOW,
  });
  assert.throws(() => planSummaryLease(badLease, NOW), /Summary retry pending lease pair is malformed/);
});

test('Subtask F: summary repair summary_dispatching calls coordinator when lease is nonempty and expired', () => {
  const expired = request({
    status: 'summary_dispatching',
    leaseOwner: 'stale-worker',
    leaseUntilIso: NOW,
  });
  const plan = planSummaryLease(expired, NOW);
  assert.equal(plan.action, 'call_coordinator');
  assert.equal(plan.targetWorkflow, 'SummaryCoordV3A1');
});

test('Subtask F: summary repair summary_dispatching returns noop when lease is active', () => {
  const active = request({
    status: 'summary_dispatching',
    leaseOwner: 'active-worker',
    leaseUntilIso: LATER,
  });
  const plan = planSummaryLease(active, NOW);
  assert.equal(plan.action, 'noop');
  assert.equal(plan.reason, 'summary_lease_active');
});

test('Subtask F: summary repair summary_dispatching throws on empty lease pair', () => {
  const emptyLease = request({
    status: 'summary_dispatching',
    leaseOwner: '',
    leaseUntilIso: '',
  });
  assert.throws(() => planSummaryLease(emptyLease, NOW), /Summary dispatching lease pair is malformed/);
});

test('Subtask F: summary repair non-eligible statuses return noop', () => {
  for (const st of ['manual_review', 'completed', 'failed', 'creating', 'creation_failed']) {
    const req = request({ status: st });
    const plan = planSummaryLease(req, NOW);
    assert.equal(plan.action, 'noop');
    assert.equal(plan.reason, 'summary_not_repairable');
  }
});

test('Subtask F: presentation repair completed attempt with retry_pending due converts to pending with cleared lease', () => {
  const att = attempt({
    status: 'completed',
    presentationStatus: 'retry_pending',
    presentationNextRetryAtIso: NOW,
    presentationLeaseOwner: '',
    presentationLeaseUntilIso: '',
    presentationAttempt: 1,
  });
  const plan = planPresentationRepair(att, NOW);
  assert.equal(plan.action, 'claim');
  assert.equal(plan.repairClass, 'presentation_lease');
  assert.deepEqual(plan.desired, {
    presentationStatus: 'pending',
    presentationLeaseOwner: '',
    presentationLeaseUntilIso: '',
    updatedAtIso: NOW,
  });
  assert.equal(plan.filters.id, att.id);
  assert.equal(plan.filters.presentationStatus, 'retry_pending');
});

test('Subtask F: presentation repair completed attempt with presenting expired converts to pending with cleared lease', () => {
  const att = attempt({
    status: 'completed',
    presentationStatus: 'presenting',
    presentationLeaseOwner: 'dead-listener',
    presentationLeaseUntilIso: NOW,
    presentationAttempt: 1,
  });
  const plan = planPresentationRepair(att, NOW);
  assert.equal(plan.action, 'claim');
  assert.equal(plan.repairClass, 'presentation_lease');
  assert.deepEqual(plan.desired, {
    presentationStatus: 'pending',
    presentationLeaseOwner: '',
    presentationLeaseUntilIso: '',
    updatedAtIso: NOW,
  });
});

test('Subtask F: presentation repair returns noop when retry_pending is in future', () => {
  const att = attempt({
    status: 'completed',
    presentationStatus: 'retry_pending',
    presentationNextRetryAtIso: LATER,
    presentationLeaseOwner: '',
    presentationLeaseUntilIso: '',
  });
  const plan = planPresentationRepair(att, NOW);
  assert.equal(plan.action, 'noop');
  assert.equal(plan.reason, 'presentation_retry_not_due');
});

test('Subtask F: presentation repair returns noop when presenting lease is active', () => {
  const att = attempt({
    status: 'completed',
    presentationStatus: 'presenting',
    presentationLeaseOwner: 'active-listener',
    presentationLeaseUntilIso: LATER,
  });
  const plan = planPresentationRepair(att, NOW);
  assert.equal(plan.action, 'noop');
  assert.equal(plan.reason, 'presentation_lease_active');
});

test('Subtask F: presentation repair returns noop for presentationStatus pending, completed, or manual_review', () => {
  for (const pStatus of ['pending', 'completed', 'manual_review']) {
    const att = attempt({ status: 'completed', presentationStatus: pStatus });
    const plan = planPresentationRepair(att, NOW);
    assert.equal(plan.action, 'noop');
    assert.equal(plan.reason, 'presentation_not_repairable');
  }
});

test('Subtask F: presentation repair returns noop when attempt status is not completed', () => {
  for (const st of ['queued', 'dispatching', 'waiting_callback', 'retry_pending', 'failed']) {
    const att = attempt({ status: st, presentationStatus: 'retry_pending', presentationNextRetryAtIso: NOW });
    assert.throws(() => planPresentationRepair(att, NOW), /requires a completed attempt/);
  }
});

test('Subtask F: presentation repair returns noop when presentationAttempt >= 3', () => {
  const att = attempt({
    status: 'completed',
    presentationStatus: 'retry_pending',
    presentationNextRetryAtIso: NOW,
    presentationAttempt: 3,
  });
  assert.throws(() => planPresentationRepair(att, NOW), /Presentation attempt cap reached/);
});

test('Subtask F: verifyPresentationRepair verifies completed pending attempt and fails closed on partial CAS', () => {
  const valid = attempt({
    id: systemID('att-pres'),
    status: 'completed',
    presentationStatus: 'pending',
    presentationLeaseOwner: '',
    presentationLeaseUntilIso: '',
    canonicalRowID: String(systemID('att-pres')),
  });
  const plan = { filters: { id: systemID('att-pres') } };
  const verified = verifyPresentationRepair([valid], plan);
  assert.equal(verified.action, 'verified');
  assert.equal(verified.canonical.id, systemID('att-pres'));

  assert.throws(() => verifyPresentationRepair([], plan), /Presentation repair rows not found/);
  assert.throws(() => verifyPresentationRepair([{ ...valid, presentationStatus: 'presenting' }], plan), /transition not verified/);
  assert.throws(() => verifyPresentationRepair([{ ...valid, presentationLeaseOwner: 'stale' }], plan), /lease was not cleared/);
});

test('Subtask F: presentation owner call plans STTListenerV3A01 with attemptKey', () => {
  const att = attempt({
    status: 'completed',
    presentationStatus: 'pending',
    attemptKey: 'summary:req-001:current:9001:fromStart:1',
  });
  const call = planPresentationOwnerCall(att);
  assert.equal(call.action, 'call_owner');
  assert.equal(call.targetWorkflow, 'STTListenerV3A01');
  assert.deepEqual(call.input, { attemptKey: 'summary:req-001:current:9001:fromStart:1' });
});

test('Subtask F: duplicate attempt reconciliation with single canonical elects canonical and demotes losers to duplicate', () => {
  const c1 = attempt({ id: systemID('att-canon'), reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-canon')) });
  const p1 = attempt({ id: systemID('att-pend'), reconciliationStatus: 'pending', canonicalRowID: '' });
  const plan = planSameKeyReconciliation([c1, p1], 'attempt', []);
  assert.equal(plan.action, 'reconcile');
  assert.equal(plan.winnerRowID, systemID('att-canon'));
  assert.equal(plan.mutations.length, 1);
  assert.equal(plan.mutations[0].id, systemID('att-pend'));
  assert.equal(plan.mutations[0].desiredReconciliationStatus, 'duplicate');
  assert.equal(plan.mutations[0].desiredCanonicalRowID, String(systemID('att-canon')));
});

test('Subtask F: duplicate attempt reconciliation with zero canonicals elects earliest as canonical and demotes others', () => {
  const p1 = attempt({ id: systemID('att-a'), createdAt: NOW, reconciliationStatus: 'pending', canonicalRowID: '' });
  const p2 = attempt({ id: systemID('att-b'), createdAt: LATER, reconciliationStatus: 'pending', canonicalRowID: '' });
  const plan = planSameKeyReconciliation([p2, p1], 'attempt', []);
  assert.equal(plan.action, 'reconcile');
  assert.equal(plan.winnerRowID, systemID('att-a'));
  assert.equal(plan.mutations.length, 2);
  const m1 = plan.mutations.find((m) => m.id === systemID('att-a'));
  const m2 = plan.mutations.find((m) => m.id === systemID('att-b'));
  assert.equal(m1.desiredReconciliationStatus, 'canonical');
  assert.equal(m1.desiredCanonicalRowID, String(systemID('att-a')));
  assert.equal(m2.desiredReconciliationStatus, 'duplicate');
  assert.equal(m2.desiredCanonicalRowID, String(systemID('att-a')));
});

test('Subtask F: duplicate attempt reconciliation multiple canonicals without checkpoint elects earliest and demotes others', () => {
  const c1 = attempt({ id: systemID('att-a'), createdAt: NOW, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-a')), status: 'queued' });
  const c2 = attempt({ id: systemID('att-b'), createdAt: LATER, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-b')), status: 'queued' });
  const plan = planSameKeyReconciliation([c1, c2], 'attempt', []);
  assert.equal(plan.action, 'reconcile');
  assert.equal(plan.winnerRowID, systemID('att-a'));
  assert.equal(plan.mutations.length, 1);
  assert.equal(plan.mutations[0].id, systemID('att-b'));
  assert.equal(plan.mutations[0].desiredReconciliationStatus, 'duplicate');
});

test('Subtask F: duplicate attempt reconciliation multiple canonicals with attempt checkpoint freezes all canonicals to manual_review', () => {
  const c1 = attempt({ id: systemID('att-a'), createdAt: NOW, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-a')), status: 'completed', dialogue: 'saved text' });
  const c2 = attempt({ id: systemID('att-b'), createdAt: LATER, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-b')), status: 'completed', dialogue: 'other text' });
  const plan = planSameKeyReconciliation([c1, c2], 'attempt', []);
  assert.equal(plan.action, 'manual_review');
  assert.equal(plan.reason, 'multiple_canonical_checkpoint_conflict');
  assert.equal(plan.mutations.length, 2);
  for (const m of plan.mutations) {
    assert.equal(m.desiredStatus, 'manual_review');
    assert.equal(m.desiredReconciliationStatus, 'canonical');
  }
});

test('Subtask F: duplicate attempt reconciliation multiple canonicals with summary checkpoint freezes all canonicals to manual_review', () => {
  const c1 = attempt({ id: systemID('att-a'), createdAt: NOW, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-a')), status: 'queued' });
  const c2 = attempt({ id: systemID('att-b'), createdAt: LATER, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-b')), status: 'queued' });
  const sum = request({ summaryMarkdown: 'checkpoint markdown', reconciliationStatus: 'canonical', canonicalRowID: String(systemID('request-a')) });
  const plan = planSameKeyReconciliation([c1, c2], 'attempt', [sum]);
  assert.equal(plan.action, 'manual_review');
  assert.equal(plan.mutations.length, 2);
});

test('Subtask F: duplicate request reconciliation clean rows demotes losers to duplicate', () => {
  const c1 = request({ id: systemID('req-a'), createdAt: NOW, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('req-a')), status: 'ready' });
  const c2 = request({ id: systemID('req-b'), createdAt: LATER, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('req-b')), status: 'ready' });
  const plan = planSameKeyReconciliation([c1, c2], 'request', []);
  assert.equal(plan.action, 'reconcile');
  assert.equal(plan.winnerRowID, systemID('req-a'));
  assert.equal(plan.mutations.length, 1);
  assert.equal(plan.mutations[0].id, systemID('req-b'));
  assert.equal(plan.mutations[0].desiredReconciliationStatus, 'duplicate');
  assert.equal(plan.mutations[0].desiredCanonicalRowID, String(systemID('req-a')));
});

test('Subtask F: duplicate request reconciliation multiple canonicals with summary checkpoint freezes canonicals to manual_review', () => {
  const c1 = request({ id: systemID('req-a'), createdAt: NOW, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('req-a')), status: 'ready', summaryMarkdown: 'saved' });
  const c2 = request({ id: systemID('req-b'), createdAt: LATER, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('req-b')), status: 'ready', summaryMarkdown: 'other' });
  const plan = planSameKeyReconciliation([c1, c2], 'request', []);
  assert.equal(plan.action, 'manual_review');
  assert.equal(plan.mutations.length, 2);
  assert.equal(plan.mutations[0].manualReviewOriginalStage, 'ready');
  assert.equal(plan.mutations[1].manualReviewOriginalStage, 'ready');
});

test('Subtask F: verifySameKeyReconciliation verifies clean canonical winner and duplicate losers', () => {
  const c1 = attempt({ id: systemID('att-a'), reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-a')) });
  const d1 = attempt({ id: systemID('att-b'), reconciliationStatus: 'duplicate', canonicalRowID: String(systemID('att-a')) });
  const verified = verifySameKeyReconciliation([c1, d1], { action: 'reconcile', winnerRowID: systemID('att-a') }, 'attempt');
  assert.equal(verified.action, 'verified');
  assert.equal(verified.canonical.id, systemID('att-a'));
});

test('Subtask F: verifySameKeyReconciliation verifies frozen canonicals on checkpoint conflict', () => {
  const f1 = attempt({ id: systemID('att-a'), status: 'manual_review', manualReviewReason: 'multiple_canonical_checkpoint_conflict', reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-a')) });
  const f2 = attempt({ id: systemID('att-b'), status: 'manual_review', manualReviewReason: 'multiple_canonical_checkpoint_conflict', reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-b')) });
  const verified = verifySameKeyReconciliation([f1, f2], { action: 'manual_review', mutations: [{ id: systemID('att-a') }, { id: systemID('att-b') }] }, 'attempt');
  assert.equal(verified.action, 'verified_frozen');
});

test('Subtask F: verifySameKeyReconciliation fails closed on partial CAS, winner mismatch, or bad linkage', () => {
  const c1 = attempt({ id: systemID('att-a'), reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-a')) });
  const broken = attempt({ id: systemID('att-b'), reconciliationStatus: 'pending', canonicalRowID: '' });
  assert.throws(() => verifySameKeyReconciliation([c1, broken], { action: 'reconcile', winnerRowID: systemID('att-a') }, 'attempt'), /loser linkage mismatch/);
  assert.throws(() => verifySameKeyReconciliation([c1], { action: 'reconcile', winnerRowID: systemID('att-other') }, 'attempt'), /winner mismatch/);
  assert.throws(() => verifySameKeyReconciliation([], { action: 'reconcile', winnerRowID: systemID('att-a') }, 'attempt'), /rows not found/);
});

test('Subtask F: duplicate reconciliation produces zero calls to dispatcher, coordinator, or presenter', () => {
  const verifyNode = node('Verify Duplicate Key Reconciliation');
  const targetNodes = targets(verifyNode.name);
  assert.deepEqual(targetNodes, ['Repair Side Effect Sink']);
});

test('Subtask F: Creation branch topology connects Limit 50 -> Reread Request -> Read Attempts -> Merge -> Preflight -> Resume Orchestrator -> Sink', () => {
  assert.deepEqual(targets('Limit Creation Lease Candidates 50'), ['Re-read Creating Request']);
  assert.deepEqual(new Set(targets('Re-read Creating Request')), new Set(['Read Creation Attempt Rows', 'Merge Creation Request And Attempts']));
  assert.deepEqual(targets('Read Creation Attempt Rows'), ['Merge Creation Request And Attempts']);
  assert.deepEqual(targets('Merge Creation Request And Attempts'), ['Tag Preflight Creation Orchestrator']);
  assert.deepEqual(targets('Tag Preflight Creation Orchestrator'), ['Preflight Creation Orchestrator']);
  assert.deepEqual(targets('Preflight Creation Orchestrator'), ['Resume Creating Request Orchestrator']);
  assert.deepEqual(targets('Resume Creating Request Orchestrator'), ['Repair Side Effect Sink']);
});

test('Subtask F: Summary branch topology connects Limit 50 -> Reread Request -> Read Attempts -> Merge -> Preflight -> Run Coordinator -> Sink', () => {
  assert.deepEqual(targets('Limit Summary Missed Event Candidates 50'), ['Re-read Summary Missed Event']);
  assert.deepEqual(new Set(targets('Re-read Summary Missed Event')), new Set(['Read Summary Attempt Rows', 'Merge Summary Request And Attempts']));
  assert.deepEqual(targets('Read Summary Attempt Rows'), ['Merge Summary Request And Attempts']);
  assert.deepEqual(targets('Merge Summary Request And Attempts'), ['Tag Preflight Summary Coordinator Call']);
  assert.deepEqual(targets('Tag Preflight Summary Coordinator Call'), ['Preflight Summary Coordinator Call']);
  assert.deepEqual(targets('Preflight Summary Coordinator Call'), ['Run Summary Coordinator Missed Event']);
  assert.deepEqual(targets('Run Summary Coordinator Missed Event'), ['Repair Side Effect Sink']);
});

test('Subtask F: Presentation branch topology connects Limit 50 -> Reread Attempt -> Read Summary -> Merge -> Plan -> Patch -> Limit 1 -> Reread -> Merge -> Verify -> Run Listener -> Sink', () => {
  assert.deepEqual(targets('Limit Presentation Repair Candidates 50'), ['Re-read Presentation Repair Attempt']);
  assert.deepEqual(new Set(targets('Re-read Presentation Repair Attempt')), new Set(['Read Presentation Summary Rows', 'Merge Presentation Attempt And Summary']));
  assert.deepEqual(targets('Read Presentation Summary Rows'), ['Merge Presentation Attempt And Summary']);
  assert.deepEqual(targets('Merge Presentation Attempt And Summary'), ['Tag Plan Presentation Repair']);
  assert.deepEqual(targets('Tag Plan Presentation Repair'), ['Plan Presentation Repair']);
  assert.deepEqual(new Set(targets('Plan Presentation Repair')), new Set(['Patch Presentation Repair', 'Merge Presentation Plan And Reread']));
  assert.deepEqual(targets('Patch Presentation Repair'), ['Limit Presentation Repair Patch']);
  assert.deepEqual(targets('Limit Presentation Repair Patch'), ['Re-read Presentation Repair Patch']);
  assert.deepEqual(targets('Re-read Presentation Repair Patch'), ['Merge Presentation Plan And Reread']);
  assert.deepEqual(targets('Merge Presentation Plan And Reread'), ['Tag Verify Presentation Repair']);
  assert.deepEqual(targets('Tag Verify Presentation Repair'), ['Verify Presentation Repair']);
  assert.deepEqual(targets('Verify Presentation Repair'), ['Run Presentation Owner Repair']);
  assert.deepEqual(targets('Run Presentation Owner Repair'), ['Repair Side Effect Sink']);
});

test('Subtask F: Duplicate key branch topology connects Limit 50 -> Reread Attempt -> Read Summary -> Merge -> Plan -> Route Action -> Reconcile/Freeze -> Limit 1 -> Reread -> Merge -> Verify -> Sink', () => {
  assert.deepEqual(targets('Limit Duplicate Key Candidates 50'), ['Re-read Duplicate Attempt Rows']);
  assert.deepEqual(new Set(targets('Re-read Duplicate Attempt Rows')), new Set(['Read Duplicate Summary Rows', 'Merge Duplicate Attempt And Summary']));
  assert.deepEqual(targets('Read Duplicate Summary Rows'), ['Merge Duplicate Attempt And Summary']);
  assert.deepEqual(targets('Merge Duplicate Attempt And Summary'), ['Tag Plan Duplicate Key Reconciliation']);
  assert.deepEqual(targets('Tag Plan Duplicate Key Reconciliation'), ['Plan Duplicate Key Reconciliation']);
  assert.deepEqual(targets('Plan Duplicate Key Reconciliation'), ['Route Duplicate Key Action']);
  assert.deepEqual(new Set(targets('Route Duplicate Key Action', 0)), new Set(['Reconcile Duplicate Attempt Exact', 'Merge Duplicate Plan And Reread']));
  assert.deepEqual(new Set(targets('Route Duplicate Key Action', 1)), new Set(['Freeze Duplicate Checkpoint Conflict Exact', 'Merge Duplicate Plan And Reread']));
  assert.deepEqual(targets('Reconcile Duplicate Attempt Exact'), ['Limit Duplicate Reconciliation']);
  assert.deepEqual(targets('Limit Duplicate Reconciliation'), ['Re-read Duplicate Attempt Rows After Mutation']);
  assert.deepEqual(targets('Freeze Duplicate Checkpoint Conflict Exact'), ['Limit Duplicate Freeze']);
  assert.deepEqual(targets('Limit Duplicate Freeze'), ['Re-read Duplicate Attempt Rows After Mutation']);
  assert.deepEqual(targets('Re-read Duplicate Attempt Rows After Mutation'), ['Merge Duplicate Plan And Reread']);
  assert.deepEqual(targets('Merge Duplicate Plan And Reread'), ['Tag Verify Duplicate Key Reconciliation']);
  assert.deepEqual(targets('Tag Verify Duplicate Key Reconciliation'), ['Verify Duplicate Key Reconciliation']);
  assert.deepEqual(targets('Verify Duplicate Key Reconciliation'), ['Repair Side Effect Sink']);
});

test('Subtask F: All new mutations use allConditions, alwaysOutputData, Limit 1, and verified reread successors', () => {
  for (const name of ['Patch Presentation Repair', 'Reconcile Duplicate Attempt Exact', 'Freeze Duplicate Checkpoint Conflict Exact']) {
    const mutNode = node(name);
    assert.equal(mutNode.parameters.matchType, 'allConditions', `${name} matchType`);
    assert.equal(mutNode.alwaysOutputData, true, `${name} alwaysOutputData`);
    const [limitName] = targets(name);
    assert.match(limitName, /^Limit /, `${name} limit target`);
    assert.equal(node(limitName).parameters.maxItems, 1, `${limitName} maxItems`);
  }
});

test('StageB: mechanical test: workflow.json contains zero occurrences of "={{ ."', () => {
  const rawJson = fs.readFileSync(path.join(workflowDir, 'workflow.json'), 'utf8');
  const matches = rawJson.match(/=\{\{\s*\./g);
  assert.equal(matches, null, `Found invalid "={{ ." syntax matches: ${matches?.length}`);
});

test('StageB: mechanical test: workflow.json expressions use direct $json only and zero named historic lookups', () => {
  const rawJson = fs.readFileSync(path.join(workflowDir, 'workflow.json'), 'utf8');
  const namedLookups = rawJson.match(/\$\('[^']+'\)/g);
  assert.equal(namedLookups, null, `Found named historic lookups: ${namedLookups?.join(', ')}`);
});

test('StageB: helper test: planRequestReconciliation is exported as a function', () => {
  assert.equal(typeof planRequestReconciliation, 'function');
});

test('StageB: helper test: planRequestReconciliation reconciles single canonical and demotes duplicate losers', () => {
  const c1 = request({ id: systemID('req-1'), status: 'ready', reconciliationStatus: 'canonical', canonicalRowID: String(systemID('req-1')) });
  const p1 = request({ id: systemID('req-2'), status: 'ready', reconciliationStatus: 'pending', canonicalRowID: '' });
  const plan = planRequestReconciliation([c1, p1], KEY);
  assert.equal(plan.action, 'reconcile');
  assert.equal(plan.winnerRowID, systemID('req-1'));
  assert.equal(plan.mutations.length, 1);
  assert.equal(plan.mutations[0].id, systemID('req-2'));
  assert.equal(plan.mutations[0].desiredReconciliationStatus, 'duplicate');
  assert.equal(plan.mutations[0].desiredCanonicalRowID, String(systemID('req-1')));
});

test('StageB: helper test: planRequestReconciliation elects system earliest when no canonical exists', () => {
  const p1 = request({ id: systemID('req-b'), createdAt: LATER, reconciliationStatus: 'pending', canonicalRowID: '' });
  const p2 = request({ id: systemID('req-a'), createdAt: NOW, reconciliationStatus: 'pending', canonicalRowID: '' });
  const plan = planRequestReconciliation([p1, p2], KEY);
  assert.equal(plan.action, 'reconcile');
  assert.equal(plan.winnerRowID, systemID('req-a'));
  assert.equal(plan.mutations.length, 2);
  const mWinner = plan.mutations.find((m) => m.id === systemID('req-a'));
  assert.equal(mWinner.desiredReconciliationStatus, 'canonical');
  assert.equal(mWinner.desiredCanonicalRowID, String(systemID('req-a')));
});

test('StageB: helper test: planRequestReconciliation freezes competing canonical requests on summary checkpoint conflict', () => {
  const c1 = request({ id: systemID('req-1'), status: 'ready', reconciliationStatus: 'canonical', canonicalRowID: String(systemID('req-1')), summaryMarkdown: 'text1' });
  const c2 = request({ id: systemID('req-2'), status: 'ready', reconciliationStatus: 'canonical', canonicalRowID: String(systemID('req-2')), summaryMarkdown: 'text2' });
  const plan = planRequestReconciliation([c1, c2], KEY);
  assert.equal(plan.action, 'manual_review');
  assert.equal(plan.reason, 'multiple_canonical_checkpoint_conflict');
  assert.equal(plan.mutations.length, 2);
  for (const m of plan.mutations) {
    assert.equal(m.desiredStatus, 'manual_review');
    assert.equal(m.desiredReconciliationStatus, 'canonical');
  }
});

test('StageB: helper test: planRequestReconciliation fails closed on mismatched requestKey or immutable conflict', () => {
  const r1 = request({ id: systemID('req-1'), requestKey: 'summary:other' });
  assert.throws(() => planRequestReconciliation([r1], KEY), /Request key mismatch/);
  assert.throws(() => planRequestReconciliation([], KEY), /Request rows not found/);
});

test('StageB: runtime test: Plan_Repairs throws when repairMode is missing or unknown', () => {
  const codePath = path.join(workflowDir, 'nodes/Plan_Repairs/jsCode.js');
  const code = fs.readFileSync(codePath, 'utf8');
  assert.match(code, /Plan Repairs requires a repairMode/);
});

test('StageB: topology test: Merge Retry Claim Attempt And Summary exists with mode append and numberInputs 2', () => {
  const merge = node('Merge Retry Claim Attempt And Summary');
  assert.equal(merge.type, 'n8n-nodes-base.merge');
  assert.equal(merge.parameters.mode, 'append');
  assert.equal(merge.parameters.numberInputs, 2);
});

test('StageB: topology test: Read Retry Same Attempt connects to Read Summary Rows and Merge Retry Claim Attempt And Summary input 0', () => {
  const readTargets = targets('Read Retry Same Attempt');
  assert.ok(readTargets.includes('Read Retry Summary Rows'));
  assert.ok(readTargets.includes('Merge Retry Claim Attempt And Summary'));
  const conn = workflow.connections['Read Retry Same Attempt'].main[0].find((c) => c.node === 'Merge Retry Claim Attempt And Summary');
  assert.equal(conn.index, 0);
});

test('StageB: topology test: Read Retry Summary Rows connects to Merge Retry Claim Attempt And Summary input 1', () => {
  const readTargets = targets('Read Retry Summary Rows');
  assert.deepEqual(readTargets, ['Merge Retry Claim Attempt And Summary']);
  const conn = workflow.connections['Read Retry Summary Rows'].main[0].find((c) => c.node === 'Merge Retry Claim Attempt And Summary');
  assert.equal(conn.index, 1);
});

test('StageB: topology test: Plan Exact Retry Claim receives merged attempt and summary rows', () => {
  assert.deepEqual(targets('Merge Retry Claim Attempt And Summary'), ['Tag Retry Claim']);
  assert.deepEqual(targets('Tag Retry Claim'), ['Plan Exact Retry Claim']);
});

test('StageB: topology test: Route Next Retry Action provides mutually exclusive branches for insert, reconcile, and freeze', () => {
  const routeInsert = node('Route Next Retry Insert');
  assert.equal(routeInsert.type, 'n8n-nodes-base.if');
  const insertTargets = targets('Route Next Retry Insert', 0);
  assert.deepEqual(insertTargets, ['Carry Next Retry Insert Plan']);
});

test('StageB: topology test: Reconcile branch does not fan out to Freeze mutation', () => {
  const reconcileCarrierTargets = targets('Carry Next Retry Reconcile Mutations');
  assert.ok(reconcileCarrierTargets.includes('Reconcile Next Retry Attempt Exact'));
  assert.equal(reconcileCarrierTargets.includes('Freeze Next Retry Checkpoint Conflict Exact'), false);
});

test('StageB: topology test: Freeze branch does not fan out to Reconcile mutation', () => {
  const freezeCarrierTargets = targets('Carry Next Retry Freeze Mutations');
  assert.ok(freezeCarrierTargets.includes('Freeze Next Retry Checkpoint Conflict Exact'));
  assert.equal(freezeCarrierTargets.includes('Reconcile Next Retry Attempt Exact'), false);
});

test('StageB: topology test: Freeze branch terminates to Repair Side Effect Sink without reaching old transition', () => {
  const freezeVerifyTargets = targets('Verify Next Retry Freeze');
  assert.deepEqual(freezeVerifyTargets, ['Repair Side Effect Sink']);
});

test('StageB: topology test: Retry insert path connects to Verify Next Retry Reconciliation without looping to Plan Next Retry Attempt', () => {
  assert.deepEqual(targets('Insert Next Retry Attempt'), ['Limit Next Retry Insert']);
  assert.deepEqual(targets('Limit Next Retry Insert'), ['Re-read Next Retry Insert Rows']);
  assert.deepEqual(targets('Re-read Next Retry Insert Rows'), ['Merge Insert Retry Plan And Reread']);
  assert.deepEqual(targets('Merge Insert Retry Plan And Reread'), ['Tag Verify Next Retry Insert']);
  assert.deepEqual(targets('Tag Verify Next Retry Insert'), ['Verify Next Retry Reconciliation']);
  assert.equal(targets('Limit Next Retry Insert').includes('Plan Next Retry Attempt'), false);
  assert.equal(targets('Re-read Next Retry Insert Rows').includes('Plan Next Retry Attempt'), false);
});

test('StageB: topology test: workflow graph is a strictly acyclic Directed Acyclic Graph with zero cycles', () => {
  const adj = new Map();
  for (const n of workflow.nodes) {
    adj.set(n.name, []);
  }
  for (const [src, outputs] of Object.entries(workflow.connections)) {
    const list = adj.get(src) || [];
    for (const branch of outputs.main || []) {
      for (const target of branch) {
        list.push(target.node);
      }
    }
    adj.set(src, list);
  }
  const visited = new Set();
  const recStack = new Set();
  const cyclePath = [];

  function hasCycle(nodeName, pathStack = []) {
    visited.add(nodeName);
    recStack.add(nodeName);
    pathStack.push(nodeName);

    for (const neighbor of adj.get(nodeName) || []) {
      if (!visited.has(neighbor)) {
        if (hasCycle(neighbor, pathStack)) return true;
      } else if (recStack.has(neighbor)) {
        cyclePath.push(...pathStack, neighbor);
        return true;
      }
    }
    recStack.delete(nodeName);
    pathStack.pop();
    return false;
  }

  for (const n of workflow.nodes) {
    if (!visited.has(n.name)) {
      if (hasCycle(n.name)) {
        assert.fail(`Graph has cycle: ${cyclePath.join(' -> ')}`);
      }
    }
  }
});

test('StageB: topology test: Plan Auto Retry Old Transition is reached strictly after Verify Next Retry Reconciliation', () => {
  assert.deepEqual(targets('Verify Next Retry Reconciliation'), ['Tag Plan Auto Retry Old Transition']);
  assert.deepEqual(targets('Tag Plan Auto Retry Old Transition'), ['Plan Auto Retry Old Transition']);
});

test('StageB: topology test: Runtime_Gates is completely removed and not referenced anywhere', () => {
  assert.equal(fs.existsSync(path.join(workflowDir, 'nodes/Runtime_Gates')), false);
  const rawJson = fs.readFileSync(path.join(workflowDir, 'workflow.json'), 'utf8');
  assert.doesNotMatch(rawJson, /Runtime_Gates/);
});

test('StageB: topology test: all dataTable mutations in workflow use matchType allConditions or are insert with alwaysOutputData and Limit 1', () => {
  for (const n of workflow.nodes) {
    if (n.type === 'n8n-nodes-base.dataTable' && ['update', 'insert'].includes(n.parameters?.operation)) {
      if (n.parameters.operation === 'update') {
        assert.equal(n.parameters.matchType, 'allConditions', `${n.name} must have matchType allConditions`);
      }
      assert.equal(n.alwaysOutputData, true, `${n.name} must have alwaysOutputData true`);
      const limit = targets(n.name)[0];
      assert.ok(limit && limit.startsWith('Limit '), `${n.name} must target a Limit node`);
      assert.equal(node(limit).parameters.maxItems, 1, `${limit} must have maxItems 1`);
    }
  }
});

test('StageB: behavior test: Plan_Repairs creation_preflight with valid request produces orchestrator input', () => {
  const req = request({ status: 'creating', creationLeaseOwner: '', creationLeaseUntilIso: '' });
  const plan = planCreationRepair(req, [], NOW);
  assert.equal(plan.action, 'resume_creation');
  assert.equal(plan.targetWorkflow, 'SummaryOrchV3A01');
});

test('StageB: behavior test: Plan_Repairs summary_preflight with valid request produces coordinator input', () => {
  const req = request({ status: 'ready', leaseOwner: '', leaseUntilIso: '' });
  const plan = planSummaryLease(req, NOW, []);
  assert.equal(plan.action, 'call_coordinator');
  assert.equal(plan.targetWorkflow, 'SummaryCoordV3A1');
});

test('StageB: behavior test: Plan_Repairs presentation repair with due attempt produces valid claim plan', () => {
  const att = attempt({ status: 'completed', presentationStatus: 'retry_pending', presentationNextRetryAtIso: NOW, presentationLeaseOwner: '', presentationLeaseUntilIso: '' });
  const plan = planPresentationRepair(att, NOW);
  assert.equal(plan.action, 'claim');
  assert.equal(plan.desired.presentationStatus, 'pending');
});

test('StageB: behavior test: Plan_Repairs duplicate attempt reconciliation produces valid mutations', () => {
  const c1 = attempt({ id: systemID('att-1'), reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-1')) });
  const p1 = attempt({ id: systemID('att-2'), reconciliationStatus: 'pending', canonicalRowID: '' });
  const plan = planSameKeyReconciliation([c1, p1], 'attempt', []);
  assert.equal(plan.action, 'reconcile');
  assert.equal(plan.winnerRowID, systemID('att-1'));
});

test('Followup 1: Plan_Repairs runtime requires uniform repairMode on all input items', () => {
  const code = fs.readFileSync(path.join(workflowDir, 'nodes/Plan_Repairs/jsCode.js'), 'utf8');
  // Missing repairMode fails
  assert.throws(() => {
    Function('$input', code)({
      all: () => [{ json: { id: systemID('att-1') } }],
      first: () => ({ json: { id: systemID('att-1') } }),
    });
  }, /repairMode/);

  // Mixed repairModes fail closed
  assert.throws(() => {
    Function('$input', code)({
      all: () => [
        { json: { id: systemID('att-1'), repairMode: 'retry_claim' } },
        { json: { id: systemID('att-2'), repairMode: 'retry_verify_claim' } },
      ],
      first: () => ({ json: { id: systemID('att-1'), repairMode: 'retry_claim' } }),
    });
  }, /uniform/i);
});

test('Followup 1: All nodes referencing Plan_Repairs receive explicit repairMode via preceding Tag or carrier', () => {
  const planRepairsNodes = workflow.nodes.filter(
    (n) => n.type === 'n8n-nodes-base.code' && n.parameters?.jsCode?.includes('Plan_Repairs/jsCode.js')
  );
  assert.ok(planRepairsNodes.length >= 10, `Expected at least 10 Plan_Repairs code nodes, got ${planRepairsNodes.length}`);
  for (const pNode of planRepairsNodes) {
    // Check predecessors in connections
    const predecessors = Object.entries(workflow.connections)
      .filter(([, conns]) => conns.main?.some((b) => b.some((t) => t.node === pNode.name)))
      .map(([src]) => src);
    assert.ok(predecessors.length > 0, `${pNode.name} must have predecessors`);
    for (const predName of predecessors) {
      const pred = node(predName);
      if (pred.type === 'n8n-nodes-base.code') {
        const predCode = pred.parameters.jsCode;
        assert.ok(
          predCode.includes('repairMode'),
          `Predecessor ${predName} for ${pNode.name} must assign repairMode`
        );
      }
    }
  }
});

test('Followup 2: planBoundedClass outputs top-level flattened deterministic fields on candidate items', () => {
  const rows = [
    attempt({ id: systemID('att-1'), status: 'dispatching', dispatchLeaseOwner: 'd-1', dispatchLeaseUntilIso: NOW }),
    request({ id: systemID('req-1'), status: 'creating', creationLeaseOwner: '', creationLeaseUntilIso: '' }),
  ];
  const dispatchCandidates = planBoundedClass('expired_dispatch_lease', [rows[0]], NOW);
  assert.equal(dispatchCandidates.length, 1);
  const dispCand = dispatchCandidates[0];
  assert.equal(dispCand.kind, 'candidate');
  assert.equal(dispCand.repairClass, 'expired_dispatch_lease');
  assert.equal(dispCand.nowIso, NOW);
  assert.equal(dispCand.id, systemID('att-1'));
  assert.equal(dispCand.attemptKey, rows[0].attemptKey);
  assert.equal(dispCand.requestKey, rows[0].requestKey);
  assert.equal(dispCand.status, 'dispatching');
  assert.equal(dispCand.reconciliationStatus, 'canonical');
  assert.equal(dispCand.canonicalRowID, String(systemID('att-1')));
  assert.ok(dispCand.locator && typeof dispCand.locator === 'object');

  const creationCandidates = planBoundedClass('creation_lease', [rows[1]], NOW);
  assert.equal(creationCandidates.length, 1);
  const reqCand = creationCandidates[0];
  assert.equal(reqCand.kind, 'candidate');
  assert.equal(reqCand.repairClass, 'creation_lease');
  assert.equal(reqCand.nowIso, NOW);
  assert.equal(reqCand.id, systemID('req-1'));
  assert.equal(reqCand.requestKey, rows[1].requestKey);
  assert.equal(reqCand.status, 'creating');
  assert.equal(reqCand.reconciliationStatus, 'canonical');
  assert.equal(reqCand.canonicalRowID, String(systemID('req-1')));
  assert.ok(reqCand.locator && typeof reqCand.locator === 'object');
});

test('Followup 2: All seven candidate re-read nodes query top-level deterministic keys', () => {
  const candidateRereads = [
    { name: 'Re-read Expired Dispatch Attempt', key: 'attemptKey', expr: '={{ $json.attemptKey }}' },
    { name: 'Re-read Callback Deadline Attempt', key: 'attemptKey', expr: '={{ $json.attemptKey }}' },
    { name: 'Read Retry Same Attempt', key: 'attemptKey', expr: '={{ $json.attemptKey }}' },
    { name: 'Re-read Creating Request', key: 'requestKey', expr: '={{ $json.requestKey }}' },
    { name: 'Re-read Summary Missed Event', key: 'requestKey', expr: '={{ $json.requestKey }}' },
    { name: 'Re-read Presentation Repair Attempt', key: 'attemptKey', expr: '={{ $json.attemptKey }}' },
    { name: 'Re-read Duplicate Attempt Rows', key: 'attemptKey', expr: '={{ $json.attemptKey }}' },
  ];
  for (const { name, key, expr } of candidateRereads) {
    const rNode = node(name);
    const cond = rNode.parameters.filters?.conditions?.find((c) => c.keyName === key);
    assert.ok(cond, `${name} must filter by ${key}`);
    assert.equal(cond.keyValue, expr, `${name} must filter with ${expr}`);
  }
});

test('Followup 3: Expired dispatch and callback deadline preserve candidate and reread via Merge append', () => {
  // Expired dispatch candidate merge
  assert.deepEqual(targets('Limit Expired Dispatch Candidates 50').sort(), [
    'Merge Expired Dispatch Candidate And Reread',
    'Re-read Expired Dispatch Attempt',
  ].sort());
  assert.deepEqual(targets('Re-read Expired Dispatch Attempt'), ['Merge Expired Dispatch Candidate And Reread']);
  assert.deepEqual(targets('Merge Expired Dispatch Candidate And Reread'), ['Tag Expired Dispatch Actual Plan']);

  // Callback deadline candidate merge
  assert.deepEqual(targets('Limit Callback Deadline Candidates 50').sort(), [
    'Merge Callback Deadline Candidate And Reread',
    'Re-read Callback Deadline Attempt',
  ].sort());
  assert.deepEqual(targets('Re-read Callback Deadline Attempt'), ['Merge Callback Deadline Candidate And Reread']);
  assert.deepEqual(targets('Merge Callback Deadline Candidate And Reread'), ['Tag Callback Deadline Actual Plan']);

  // Tag Expired Dispatch Actual Plan preserves full raw row and nowIso
  const tagDispCode = node('Tag Expired Dispatch Actual Plan').parameters.jsCode;
  const candidate = { kind: 'candidate', nowIso: NOW, attemptKey: 'job:1' };
  const rawRow = attempt({ id: systemID('att-1'), status: 'dispatching', dispatchLeaseOwner: 'd-1', dispatchLeaseUntilIso: NOW });
  const taggedDisp = Function('$input', tagDispCode)({
    all: () => [{ json: candidate }, { json: rawRow }],
  });
  assert.equal(taggedDisp.length, 1);
  assert.equal(taggedDisp[0].json.id, systemID('att-1'));
  assert.equal(taggedDisp[0].json.nowIso, NOW);
  assert.equal(taggedDisp[0].json.repairMode, 'actual:expired_dispatch');
  assert.equal(taggedDisp[0].json.status, 'dispatching');

  // Tag Callback Deadline Actual Plan preserves full raw row and nowIso
  const tagCbCode = node('Tag Callback Deadline Actual Plan').parameters.jsCode;
  const cbCandidate = { kind: 'candidate', nowIso: NOW, attemptKey: 'job:1' };
  const cbRawRow = attempt({ id: systemID('att-2'), status: 'waiting_callback', callbackDeadlineAtIso: NOW });
  const taggedCb = Function('$input', tagCbCode)({
    all: () => [{ json: cbCandidate }, { json: cbRawRow }],
  });
  assert.equal(taggedCb.length, 1);
  assert.equal(taggedCb[0].json.id, systemID('att-2'));
  assert.equal(taggedCb[0].json.nowIso, NOW);
  assert.equal(taggedCb[0].json.repairMode, 'actual:callback_deadline');
  assert.equal(taggedCb[0].json.status, 'waiting_callback');
});

test('Followup 4: Absent cap error path terminates to Repair Side Effect Sink with zero duplicate writes', () => {
  const pendingCapVerifierTargets = targets('Verify Pending Cap Error Canonical');
  assert.deepEqual(pendingCapVerifierTargets, ['Repair Side Effect Sink']);
  const insertDuplicatePredecessors = Object.entries(workflow.connections).filter(([, conns]) =>
    conns.main?.some((branch) => branch.some((target) => target.node === 'Insert Duplicate Cap Error'))
  ).map(([source]) => source);
  assert.ok(!insertDuplicatePredecessors.includes('Verify Pending Cap Error Canonical'));
  assert.ok(!insertDuplicatePredecessors.includes('Re-read Pending Cap Error Canonical'));
  assert.deepEqual(insertDuplicatePredecessors.sort(), [
    'Needs Cap Error Reconciliation',
    'Verify Cap Error Reconciliation',
  ].sort());
});

test('Followup 1 & 4: All 9 listed Plan_Repairs nodes execute correctly with tagged inputs and strict mode checking', () => {
  const planRepairsCode = fs.readFileSync(path.join(workflowDir, 'nodes/Plan_Repairs/jsCode.js'), 'utf8');
  function executePlanRepairs(items) {
    return Function('$input', planRepairsCode)({
      all: () => items.map((json) => ({ json })),
      first: () => ({ json: items[0] || {} }),
    });
  }

  // 1. Plan Exact Retry Claim
  const retryAtt = attempt({ id: systemID('att-1'), status: 'retry_pending', nextRetryAtIso: NOW, retryLeaseOwner: '', retryLeaseUntilIso: '' });
  const retrySummary = request({ id: systemID('req-1') });
  const claimResult = executePlanRepairs([
    { ...retryAtt, repairMode: 'retry_claim' },
    { ...retrySummary, repairMode: 'retry_claim' },
  ]);
  assert.equal(claimResult.length, 1);
  assert.equal(claimResult[0].json.action, 'claim');
  assert.equal(claimResult[0].json.repairMode, 'retry_verify_claim');

  // 2. Preflight Creation Orchestrator
  const creatingReq = request({ id: systemID('req-2'), status: 'creating', creationLeaseOwner: '', creationLeaseUntilIso: '' });
  const creationResult = executePlanRepairs([
    { ...creatingReq, repairMode: 'creation_preflight' },
  ]);
  assert.equal(creationResult.length, 1);
  assert.equal(creationResult[0].json.requestKey, creatingReq.requestKey);

  // 3. Preflight Summary Coordinator Call
  const readyReq = request({ id: systemID('req-3'), status: 'ready', leaseOwner: '', leaseUntilIso: '' });
  const summaryResult = executePlanRepairs([
    { ...readyReq, repairMode: 'summary_preflight' },
  ]);
  assert.equal(summaryResult.length, 1);
  assert.equal(summaryResult[0].json.requestKey, readyReq.requestKey);

  // 4. Plan Presentation Repair
  const presAtt = attempt({ id: systemID('att-3'), status: 'completed', presentationStatus: 'retry_pending', presentationNextRetryAtIso: NOW, presentationLeaseOwner: '', presentationLeaseUntilIso: '' });
  const presResult = executePlanRepairs([
    { ...presAtt, repairMode: 'presentation_plan' },
  ]);
  assert.equal(presResult.length, 1);
  assert.equal(presResult[0].json.action, 'claim');

  // 5. Plan Duplicate Key Reconciliation
  const dupAtt1 = attempt({ id: systemID('att-4a'), reconciliationStatus: 'canonical', canonicalRowID: String(systemID('att-4a')) });
  const dupAtt2 = attempt({ id: systemID('att-4b'), reconciliationStatus: 'pending', canonicalRowID: '' });
  const dupResult = executePlanRepairs([
    { ...dupAtt1, repairMode: 'duplicate_plan' },
    { ...dupAtt2, repairMode: 'duplicate_plan' },
  ]);
  assert.equal(dupResult.length, 1);
  assert.equal(dupResult[0].json.action, 'reconcile');

  // 6. Plan Cap Error Rows
  const capCandidate = planRepairCapError('expired_dispatch_lease', 55, NOW);
  const capResult = executePlanRepairs([
    { ...capCandidate, repairMode: 'cap_error_rows' },
  ]);
  assert.equal(capResult.length, 1);
  assert.equal(capResult[0].json.action, 'insert_pending');

  // 7. Plan Pending Cap Error Canonical
  const pendingCapRow = { ...capCandidate, id: systemID('err-1'), createdAt: NOW, reconciliationStatus: 'pending', canonicalRowID: '' };
  const pendingCapResult = executePlanRepairs([
    { ...pendingCapRow, repairMode: 'pending_cap_canonical' },
  ]);
  assert.equal(pendingCapResult.length, 1);
  assert.equal(pendingCapResult[0].json.desiredReconciliationStatus, 'canonical');
  assert.equal(pendingCapResult[0].json.desiredCanonicalRowID, String(systemID('err-1')));

  // 8. Verify Cap Error Reconciliation
  const canonicalCapRow = { ...pendingCapRow, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('err-1')) };
  const verifyCapResult = executePlanRepairs([
    { ...canonicalCapRow, repairMode: 'verify_cap_reconciliation' },
  ]);
  assert.deepEqual(verifyCapResult, [{ json: { canonicalRowID: String(systemID('err-1')) } }]);

  // 9. Verify Duplicate Cap Error
  const duplicateCapRow = { ...pendingCapRow, id: systemID('err-2'), createdAt: LATER, reconciliationStatus: 'duplicate', canonicalRowID: String(systemID('err-1')) };
  const verifyDupCapResult = executePlanRepairs([
    { ...canonicalCapRow, repairMode: 'verify_duplicate_cap' },
    { ...duplicateCapRow, repairMode: 'verify_duplicate_cap' },
  ]);
  assert.deepEqual(verifyDupCapResult, [{ json: { errorKey: canonicalCapRow.errorKey, canonicalRowID: String(systemID('err-1')) } }]);
});

test('Followup 4: Simulation: Cap error overflow produces pending canonical on absent, and duplicate on existing canonical', () => {
  const planRepairsCode = fs.readFileSync(path.join(workflowDir, 'nodes/Plan_Repairs/jsCode.js'), 'utf8');
  function runNode(items) {
    return Function('$input', planRepairsCode)({
      all: () => items.map((json) => ({ json })),
      first: () => ({ json: items[0] || {} }),
    });
  }

  // Case 1: Absent Cap Error
  const capCandidate = planRepairCapError('creation_lease', 60, NOW);
  const planAbsent = runNode([{ ...capCandidate, repairMode: 'cap_error_rows' }]);
  assert.equal(planAbsent[0].json.action, 'insert_pending');

  // Inserted row -> Reread -> Plan Pending Canonical
  const insertedRow = { ...capCandidate, id: systemID('err-100'), createdAt: NOW, reconciliationStatus: 'pending', canonicalRowID: '' };
  const planPending = runNode([{ ...insertedRow, repairMode: 'pending_cap_canonical' }]);
  assert.equal(planPending[0].json.desiredReconciliationStatus, 'canonical');
  assert.equal(planPending[0].json.desiredCanonicalRowID, String(systemID('err-100')));

  // Canonicalized row -> Verify Pending Cap Error Canonical -> Sink
  const canonicalRow = { ...insertedRow, reconciliationStatus: 'canonical', canonicalRowID: String(systemID('err-100')) };
  const verifyPending = runNode([{ ...canonicalRow, repairMode: 'verify_cap_reconciliation' }]);
  assert.deepEqual(verifyPending, [{ json: { canonicalRowID: String(systemID('err-100')) } }]);

  // Case 2: Existing Canonical Cap Error
  const existingDbRow = {
    id: systemID('err-100'),
    errorKey: capCandidate.errorKey,
    component: capCandidate.component,
    reconciliationStatus: 'canonical',
    canonicalRowID: String(systemID('err-100')),
    requestKey: '',
    logicalJobKey: '',
    attemptKey: '',
    executionID: '',
    workflowName: capCandidate.workflowName,
    nodeName: capCandidate.nodeName,
    errorCode: capCandidate.errorCode,
    messageMasked: capCandidate.messageMasked,
    retryable: false,
    createdAtIso: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const planExisting = runNode([
    { ...capCandidate, repairMode: 'cap_error_rows' },
    { ...existingDbRow, repairMode: 'cap_error_rows' },
  ]);
  assert.equal(planExisting[0].json.action, 'insert_duplicate');
  assert.equal(planExisting[0].json.canonicalRowID, String(systemID('err-100')));
});
