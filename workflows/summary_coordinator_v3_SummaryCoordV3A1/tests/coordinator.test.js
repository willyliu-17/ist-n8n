const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  aggregateLogicalJobs, planRequestReconciliation, planRequestResolution, runRequestResolution,
  plainObject: aggregatePlainObject, validateRequestRows, verifyRequestReconciliation,
} = require('../nodes/Aggregate_Logical_Jobs/jsCode');
const { buildSummaryInput } = require('../nodes/Build_Summary_Input/jsCode');
const {
  planAllFailedWrite, planCoverageFromRuntime, planCoverageWrite, verifyCoverageWrite,
} = require('../nodes/Plan_Coverage_Write/jsCode');
const { planClaim } = require('../nodes/Plan_Claim/jsCode');
const { plainObject: claimPlainObject } = require('../nodes/Plan_Claim_Reconciliation/jsCode');
const { verifyClaim, verifyClaimRuntime } = require('../nodes/Verify_Claim/jsCode');
const { splitPlanAndRows, verifyPlan, verifyCarrierInput: verifyInitialCarrierInput } = require('../nodes/Verify_Initial_Plan/jsCode');
const { verifyCarrierInput: verifyClaimTimeCarrierInput } = require('../nodes/Verify_Claim_Time_Plan/jsCode');
const { verifyCarrierInput: verifyPreflightCarrierInput } = require('../nodes/Verify_Preflight_Plan/jsCode');
const { splitPlanAndRows: splitCoverageCarrierAndRows } = require('../nodes/Verify_Request_Write/jsCode');
const { plainObject: preflightPlainObject, preflightAI, runPreflightRuntime } = require('../nodes/Preflight_AI/jsCode');

const NOW = '2026-08-24T00:00:00.000Z';
const LATER = '2026-08-24T00:10:00.000Z';
const KEY = 'summary:req-001';
const STREAMS = [
  { role: 'current', liveStreamID: '9001', mode: 'fromStart', streamContext: { liveStreamID: '9001', eligible: true, beginTime: 1787360400, endTime: 1787364000 } },
  { role: 'previous', liveStreamID: '9000', mode: 'fromEnd', streamContext: { liveStreamID: '9000', eligible: true, beginTime: 1787360400, endTime: 1787364000 } },
];
const expected = STREAMS.map((stream) => `${KEY}:${stream.role}:${stream.liveStreamID}:${stream.mode}`);
function request(overrides = {}) {
  const { id = 101, canonicalRowID, ...rest } = overrides;
  return { id, createdAt: NOW, updatedAt: NOW, requestKey: KEY, requestType: 'suspect', status: 'waiting_stt', reconciliationStatus: 'canonical', canonicalRowID: canonicalRowID === undefined ? String(id) : String(canonicalRowID), orderedStreamsJson: JSON.stringify(STREAMS), existingDialoguesJson: '{}', expectedLogicalJobKeysJson: JSON.stringify(expected), channel: 'C0A4JJJKJMD', threadTS: '1787364000.000001', leaseOwner: '', leaseUntilIso: '', ...rest };
}
function attempt(role = 'current', overrides = {}) {
  const stream = STREAMS.find((item) => item.role === role);
  const logicalJobKey = `${KEY}:${role}:${stream.liveStreamID}:${stream.mode}`;
  const number = overrides.attempt || 1;
  const { id = (role === 'current' ? 200 + number : 210 + number), canonicalRowID, ...rest } = overrides;
  return { id, createdAt: NOW, updatedAt: NOW, requestKey: KEY, requestType: 'suspect', logicalJobKey, attemptKey: `${logicalJobKey}:${number}`, attempt: number, role, streamID: String(stream.liveStreamID), mode: stream.mode, streamContextJson: JSON.stringify(stream.streamContext), status: 'completed', dialogue: `${role} dialogue`, language: '', errorCode: '', reconciliationStatus: 'canonical', canonicalRowID: canonicalRowID === undefined ? String(id) : String(canonicalRowID), manualReviewResolution: '', ...rest };
}
function manual(id, stage = 'ready', checkpoint = '') {
  return request({ id, canonicalRowID: String(id), status: 'manual_review', manualReviewOriginalStage: stage, summaryMarkdown: checkpoint, createdAt: id === 101 ? NOW : LATER, manualReviewResolution: '', manualResolutionDecisionID: '', manualResolutionWinnerRowID: '' });
}

test('accepts plain records across runtime realms', () => {
  const foreignRecord = vm.runInNewContext('({ eligible: true })');
  for (const predicate of [aggregatePlainObject, claimPlainObject, preflightPlainObject]) {
    assert.equal(predicate(foreignRecord), true);
    assert.equal(predicate(Object.create(null)), true);
    assert.equal(predicate([]), false);
    assert.equal(predicate(null), false);
    assert.equal(predicate('context'), false);
  }
});

test('validates complete request system linkage and immutable JSON', () => {
  validateRequestRows([request()], KEY);
  assert.throws(() => validateRequestRows([{ ...request(), id: '101', canonicalRowID: '101' }], KEY), /system fields/);
  assert.throws(() => validateRequestRows([{ ...request(), canonicalRowID: 101 }], KEY), /self-link/);
  assert.throws(() => validateRequestRows([request({ channel: 'C09bad' }) , request({ id: 102, canonicalRowID: '102' })], KEY), /immutable replay/);
  assert.throws(() => validateRequestRows([request({ orderedStreamsJson: '[]' })], KEY), /immutable fields mismatch/);
});
test('preserves an existing canonical and elects earliest only when absent', () => {
  const permanent = planRequestReconciliation([request({ id: 126, canonicalRowID: '126' }), request({ id: 101, reconciliationStatus: 'pending', canonicalRowID: '', createdAt: LATER })], KEY);
  assert.equal(permanent.winnerRowID, 126);
  assert.equal(planRequestReconciliation([request({ id: 102, reconciliationStatus: 'pending', canonicalRowID: '' }), request({ id: 101, reconciliationStatus: 'pending', canonicalRowID: '' })], KEY).winnerRowID, 101);
});
test('reconciles clean multiple canonicals and exact verifier rejects incomplete mutations', () => {
  const rows = [request({ id: 102, canonicalRowID: '102' }), request({ id: 101, canonicalRowID: '101' })];
  const plan = planRequestReconciliation(rows, KEY);
  assert.equal(plan.action, 'reconcile'); assert.equal(plan.winnerRowID, 101);
  assert.throws(() => verifyRequestReconciliation(rows, plan), /verification failed/);
  rows[0].reconciliationStatus = 'duplicate'; rows[0].canonicalRowID = '101';
  assert.equal(verifyRequestReconciliation(rows, plan).id, 101);
});
test('freezes checkpoint-bearing multiple canonicals', () => {
  const plan = planRequestReconciliation([request({ id: 101, canonicalRowID: '101', status: 'ready' }), request({ id: 102, canonicalRowID: '102', status: 'summary_dispatching', summaryMarkdown: 'checkpoint' })], KEY);
  assert.equal(plan.action, 'manual_review'); assert.equal(plan.mutations.length, 2);
});
test('freezes all competing canonicals when a duplicate or pending row carries a checkpoint', () => {
  const canonicals = [request({ id: 101, canonicalRowID: '101', status: 'ready' }), request({ id: 102, canonicalRowID: '102', status: 'ready' })];
  for (const noncanonical of [request({ id: 103, reconciliationStatus: 'duplicate', canonicalRowID: '101', summaryMarkdown: 'checkpoint' }), request({ id: 103, reconciliationStatus: 'pending', canonicalRowID: '', summaryMarkdown: 'checkpoint' })]) {
    const plan = planRequestReconciliation([...canonicals, noncanonical], KEY);
    assert.equal(plan.action, 'manual_review');
    assert.deepEqual(plan.mutations.map(({ id }) => id), [101, 102]);
  }
});
test('aggregates lowest completed nonempty dialogue in ordered streams', () => {
  const result = aggregateLogicalJobs(request(), [attempt('current', { attempt: 2, id: 202, canonicalRowID: '202', dialogue: 'later' }), attempt('current', { language: 'zh' }), attempt('previous')]);
  assert.equal(result.coverageStatus, 'complete'); assert.equal(result.streams[0].dialogue, 'current dialogue');
  assert.deepEqual(result.availableRoles, ['current', 'previous']);
  assert.deepEqual(result.streams[0].transcript, { outcome: 'transcribed', language: 'zh', errorCode: '' });
});
test('treats completed empty transcription as complete stream coverage', () => {
  const result = aggregateLogicalJobs(request(), [
    attempt('current', { dialogue: '', language: '', errorCode: 'callback_empty_transcription' }),
    attempt('previous'),
  ]);
  assert.equal(result.action, 'ready');
  assert.equal(result.coverageStatus, 'complete');
  assert.deepEqual(result.availableRoles, ['current', 'previous']);
  assert.equal(result.streams[0].dialogue, '');
  assert.deepEqual(result.streams[0].transcript, { outcome: 'empty', language: '', errorCode: 'callback_empty_transcription' });
});
test('treats timed-out summary STT as missing evidence and keeps failed-only coverage terminal', () => {
  assert.equal(aggregateLogicalJobs(request(), [attempt('current'), attempt('previous', { status: 'failed', dialogue: '' })]).coverageStatus, 'partial');
  const timedOut = aggregateLogicalJobs(request(), [attempt('current', { status: 'failed', dialogue: '' }), attempt('previous', { status: 'timed_out', dialogue: '' })]);
  assert.equal(timedOut.action, 'ready');
  assert.equal(timedOut.coverageStatus, 'partial');
  assert.deepEqual(timedOut.availableRoles, []);
  assert.deepEqual(timedOut.missingRoles, ['current', 'previous']);
  assert.deepEqual(timedOut.streams.map(({ dialogue }) => dialogue), ['', '']);
  assert.deepEqual(timedOut.streams.map(({ transcript }) => transcript.outcome), ['failed', 'timed_out']);
  const allTimedOut = aggregateLogicalJobs(request(), [
    attempt('current', { status: 'timed_out', dialogue: '' }),
    attempt('previous', { status: 'timed_out', dialogue: '' }),
  ]);
  assert.equal(allTimedOut.action, 'ready');
  assert.equal(allTimedOut.coverageStatus, 'partial');
  assert.deepEqual(allTimedOut.availableRoles, []);
  assert.deepEqual(allTimedOut.missingRoles, ['current', 'previous']);
  assert.deepEqual(allTimedOut.streams.map(({ dialogue }) => dialogue), ['', '']);
  assert.equal(aggregateLogicalJobs(request(), [attempt('current', { status: 'failed', dialogue: '' }), attempt('previous', { status: 'failed', dialogue: '' })]).action, 'all_failed');
});
test('uses the actual timed-out attempt for transcript metadata during aggregation and preflight', () => {
  const attempts = [
    attempt('current', { status: 'timed_out', dialogue: '', language: 'zh', errorCode: 'TIMEOUT_EVIDENCE' }),
    attempt('current', { attempt: 2, id: 202, canonicalRowID: '202', status: 'failed', dialogue: '', language: 'en', errorCode: 'WRONG_FAILED' }),
    attempt('previous'),
  ];
  const coverage = aggregateLogicalJobs(request(), attempts);
  assert.deepEqual(coverage.streams[0].transcript, { outcome: 'timed_out', language: 'zh', errorCode: 'TIMEOUT_EVIDENCE' });

  const claimed = request({
    status: 'summary_dispatching',
    leaseOwner: 'exec-a',
    leaseUntilIso: LATER,
    coverageStatus: coverage.coverageStatus,
    availableRolesJson: JSON.stringify(coverage.availableRoles),
    missingRolesJson: JSON.stringify(coverage.missingRoles),
    failedLogicalJobKeysJson: JSON.stringify(coverage.failedLogicalJobKeys),
  });
  const [preflight] = runPreflightRuntime([claimed], attempts, KEY, 'exec-a', NOW);
  assert.deepEqual(preflight.streams[0].transcript, { outcome: 'timed_out', language: 'zh', errorCode: 'TIMEOUT_EVIDENCE' });
});

test('keeps an unavailable stream in partial AI evidence without requiring an attempt', () => {
  const streams = [
    STREAMS[0],
    { ...STREAMS[1], sttEligible: false, streamContext: { ...STREAMS[1].streamContext, eligible: false, openID: null, missingFields: ['openID'] } },
  ];
  const result = aggregateLogicalJobs(request({
    orderedStreamsJson: JSON.stringify(streams),
    expectedLogicalJobKeysJson: JSON.stringify([expected[0]]),
  }), [attempt('current')]);

  assert.equal(result.action, 'ready');
  assert.equal(result.coverageStatus, 'partial');
  assert.deepEqual(result.availableRoles, ['current']);
  assert.deepEqual(result.missingRoles, ['previous']);
  assert.equal(result.streams.length, 2);
  assert.equal(result.streams[1].dialogue, '');
  assert.equal(result.streams[1].transcript.outcome, 'ineligible');
  assert.equal(result.streams[1].streamContext.eligible, false);
});
test('marks caller-provided dialogue distinctly without creating an attempt', () => {
  const existingDialoguesJson = JSON.stringify({ current: { logicalJobKey: expected[0], dialogue: 'provided dialogue' } });
  const result = aggregateLogicalJobs(request({ existingDialoguesJson, expectedLogicalJobKeysJson: JSON.stringify([expected[1]]) }), [attempt('previous')]);

  assert.equal(result.streams[0].dialogue, 'provided dialogue');
  assert.deepEqual(result.streams[0].transcript, { outcome: 'provided', language: '', errorCode: '' });
});
test('pending and unresolved manual block coverage', () => {
  assert.equal(aggregateLogicalJobs(request(), [attempt('current', { status: 'queued', dialogue: '' }), attempt('previous')]).action, 'pending');
  assert.equal(aggregateLogicalJobs(request(), [attempt('current', { status: 'manual_review', dialogue: '' }), attempt('previous')]).action, 'pending');
});
test('resolved manual and retry_materialized follow exact next canonical attempt', () => {
  const old = attempt('current', { status: 'retry_materialized', dialogue: '', manualReviewResolution: `retry_created:${expected[0]}:2` });
  const next = attempt('current', { attempt: 2, id: 202, canonicalRowID: '202', status: 'completed', dialogue: 'retried' });
  const result = aggregateLogicalJobs(request(), [old, next, attempt('previous')]);
  assert.equal(result.coverageStatus, 'complete'); assert.equal(result.streams[0].dialogue, 'retried');
});
test('terminal retry chain ignores superseded attempts and reports all failed', () => {
  const chain = ['current', 'previous'].flatMap((role, roleIndex) => {
    const key = expected[roleIndex];
    return [
      attempt(role, { status: 'retry_materialized', dialogue: '', manualReviewResolution: `retry_created:${key}:2` }),
      attempt(role, { attempt: 2, id: 202 + roleIndex * 10, canonicalRowID: String(202 + roleIndex * 10), status: 'retry_materialized', dialogue: '', manualReviewResolution: `retry_created:${key}:3` }),
      attempt(role, { attempt: 3, id: 203 + roleIndex * 10, canonicalRowID: String(203 + roleIndex * 10), status: 'failed', dialogue: '' }),
    ];
  });
  const result = aggregateLogicalJobs(request(), chain);
  assert.equal(result.action, 'all_failed');
  assert.deepEqual(result.failedLogicalJobKeys, expected);
});
test('broken retry chains and malformed attempts fail closed', () => {
  assert.throws(() => aggregateLogicalJobs(request(), [attempt('current', { status: 'retry_materialized', dialogue: '', manualReviewResolution: 'retry_created:wrong:2' }), attempt('previous')]), /broken retry/);
  assert.throws(() => aggregateLogicalJobs(request(), [attempt('current', { attemptKey: 'bad' }), attempt('previous')]), /identity/);
});
test('coverage writes only waiting_stt exact snapshot to ready', () => {
  const aggregate = aggregateLogicalJobs(request(), [attempt('current'), attempt('previous', { status: 'failed', dialogue: '' })]);
  const plan = planCoverageWrite(request(), aggregate);
  assert.equal(plan.action, 'write_ready'); assert.equal(plan.desired.coverageStatus, 'partial');
  const written = { ...request(), ...plan.desired };
  assert.equal(verifyCoverageWrite([written], plan).status, 'ready');
});
test('runtime coverage planning keeps the persisted pre-aggregate CAS snapshot', () => {
  const persisted = request({
    coverageStatus: 'waiting_stt',
    availableRolesJson: '[]',
    missingRolesJson: '["current","previous"]',
    failedLogicalJobKeysJson: '[]',
  });
  const aggregate = aggregateLogicalJobs(persisted, [attempt('current'), attempt('previous')]);
  const plan = planCoverageFromRuntime({ ...persisted, ...aggregate, persistedRequest: persisted });

  assert.equal(plan.action, 'write_ready');
  assert.equal(plan.expected.status, 'waiting_stt');
  assert.equal(plan.expected.coverageStatus, 'waiting_stt');
  assert.equal(plan.desired.status, 'ready');
  assert.equal(plan.desired.coverageStatus, 'complete');
});
test('coverage replay verifies exact primitive JSON for every claimable state', () => {
  const aggregate = aggregateLogicalJobs(request(), [attempt('current'), attempt('previous', { status: 'failed', dialogue: '' })]);
  const snapshot = { coverageStatus: 'partial', availableRolesJson: '["current"]', missingRolesJson: '["previous"]', failedLogicalJobKeysJson: JSON.stringify([expected[1]]) };
  for (const status of ['ready', 'summary_dispatching', 'summary_retry_pending']) {
    const row = request({ status, ...snapshot });
    const plan = planCoverageWrite(row, aggregate);
    assert.equal(plan.action, 'replay');
    assert.equal(plan.expected.status, status);
  }
  assert.equal(planCoverageWrite(request({ status: 'completed' }), aggregate).action, 'noop');
  assert.throws(() => verifyCoverageWrite([{ ...request(), ...snapshot }], planCoverageWrite(request({ status: 'ready', ...snapshot }), aggregate)), /mismatch/);
  for (const field of Object.keys(snapshot)) {
    const mismatched = { ...snapshot, [field]: field === 'coverageStatus' ? 'complete' : '[]' };
    for (const status of ['ready', 'summary_dispatching', 'summary_retry_pending']) {
      assert.throws(() => planCoverageWrite(request({ status, ...mismatched }), aggregate), new RegExp(`coverage replay mismatch: ${field}`));
    }
  }
});
test('all-failed plan writes fixed failure and clears lease', () => {
  const plan = planAllFailedWrite(request({ leaseOwner: 'old', leaseUntilIso: LATER }));
  const written = { ...request(), ...plan.desired };
  assert.equal(verifyCoverageWrite([written], plan).errorCode, 'SUMMARY_ALL_STT_LOGICAL_JOBS_FAILED');
  assert.equal(planAllFailedWrite(request({ status: 'ready' })).expected.status, 'ready');
  assert.deepEqual(planAllFailedWrite(request({ status: 'failed', errorCode: 'SUMMARY_ALL_STT_LOGICAL_JOBS_FAILED' })), { action: 'noop', reason: 'all_failed_persisted', id: 101, requestKey: KEY });
});
test('initial claim has exact empty lease snapshot and twenty-four-hour UTC ISO', () => {
  const plan = planClaim(request({ status: 'ready' }), NOW, 'exec-a');
  assert.equal(plan.action, 'initial'); assert.equal(plan.leaseUntilIso, '2026-08-25T00:00:00.000Z'); assert.equal(plan.expectedLeaseOwner, ''); assert.equal(plan.expectedCanonicalRowID, '101');
});
test('retry-due claim snapshots exact due fields and rejects future due', () => {
  const due = planClaim(request({ status: 'summary_retry_pending', nextRetryAtIso: NOW }), NOW, 'exec-a');
  assert.equal(due.action, 'retry_due'); assert.equal(due.expectedNextRetryAtIso, NOW); assert.equal(due.expectedLeaseOwner, '');
  assert.equal(planClaim(request({ status: 'summary_retry_pending', nextRetryAtIso: NOW, leaseOwner: 'old', leaseUntilIso: NOW }), NOW, 'exec-a').action, 'retry_due');
  assert.equal(planClaim(request({ status: 'summary_retry_pending', nextRetryAtIso: NOW, leaseOwner: 'foreign', leaseUntilIso: LATER }), NOW, 'exec-a').action, 'noop');
  assert.equal(planClaim(request({ status: 'summary_retry_pending', nextRetryAtIso: NOW, leaseOwner: 'exec-a', leaseUntilIso: LATER }), NOW, 'exec-a').action, 'noop');
  assert.throws(() => planClaim(request({ status: 'summary_retry_pending', nextRetryAtIso: NOW, leaseOwner: 'old', leaseUntilIso: '' }), NOW, 'exec-a'), /lease pair is malformed/);
  assert.throws(() => planClaim(request({ status: 'summary_retry_pending', nextRetryAtIso: NOW, leaseOwner: '', leaseUntilIso: NOW }), NOW, 'exec-a'), /lease pair is malformed/);
  assert.equal(planClaim(request({ status: 'summary_retry_pending', nextRetryAtIso: LATER }), NOW, 'exec-a').action, 'noop');
});
test('phase carrier split rejects missing, mixed, duplicate, empty, and partial plan inputs', () => {
  const carrier = { id: 101, __planCarrier: true, __planPhase: 'initial', __planAction: 'reconcile', action: 'reconcile' };
  const row = request({ id: 101 });
  assert.deepEqual(splitPlanAndRows([carrier, row], 'initial').plans.map(({ id }) => id), [101]);
  assert.throws(() => splitPlanAndRows([row], 'initial'), /missing plan carrier/);
  assert.throws(() => splitPlanAndRows([carrier], 'initial'), /missing plan carrier/);
  assert.throws(() => splitPlanAndRows([carrier, { ...carrier }, row, request({ id: 102 })], 'initial'), /duplicate plan carrier/);
  assert.throws(() => splitPlanAndRows([{ ...carrier, __planPhase: 'claim' }, row], 'initial'), /mixed phase/);
  assert.throws(() => splitPlanAndRows([{ ...carrier, __planAction: 'manual_review' }, row], 'initial'), /mixed action/);
  assert.throws(() => verifyPlan([row], [
    { id: 101, desiredReconciliationStatus: 'canonical', desiredCanonicalRowID: '101' },
    { id: 102, desiredReconciliationStatus: 'duplicate', desiredCanonicalRowID: '101' },
  ], 'reconcile', KEY), /partial/);
});
test('expired claim requires nonempty expired lease and strict millisecond ISO', () => {
  assert.equal(planClaim(request({ status: 'summary_dispatching', leaseOwner: 'old', leaseUntilIso: NOW }), NOW, 'exec-a').action, 'expired');
  assert.throws(() => planClaim(request({ status: 'summary_dispatching', leaseOwner: 'old', leaseUntilIso: '2026-08-24T00:00:00Z' }), NOW, 'exec-a'), /invalid lease expiry/);
  assert.throws(() => planClaim(request({ status: 'summary_dispatching', leaseUntilIso: NOW }), NOW, 'exec-a'), /lease owner/);
});
test('claim verifier requires one current canonical owner and exact unexpired lease', () => {
  const row = request({ status: 'summary_dispatching', leaseOwner: 'exec-a', leaseUntilIso: LATER });
  assert.equal(verifyClaim([row], KEY, 'exec-a', NOW, LATER).id, 101);
  assert.throws(() => verifyClaim([row, request({ id: 102, canonicalRowID: '102', status: 'summary_dispatching', leaseOwner: 'exec-a', leaseUntilIso: LATER })], KEY, 'exec-a', NOW), /exactly one/);
});
test('claim verifier treats an exact lease loser as a no-op', () => {
  const plan = { __planCarrier: true, __planPhase: 'claim', __planAction: 'claim', action: 'claim', requestKey: KEY, owner: 'exec-a', leaseUntilIso: LATER };
  const row = request({ status: 'summary_dispatching', leaseOwner: 'exec-b', leaseUntilIso: LATER });
  assert.deepEqual(verifyClaimRuntime([plan, row], NOW), []);
});
test('pre-AI re-reconciles clean races and freezes checkpoint conflicts', () => {
  const clean = [request({ id: 101, status: 'summary_dispatching', leaseOwner: 'exec-a', leaseUntilIso: LATER }), request({ id: 102, canonicalRowID: '102', reconciliationStatus: 'canonical', status: 'summary_dispatching', leaseOwner: 'exec-a', leaseUntilIso: LATER })];
  assert.equal(preflightAI(clean, [attempt('current'), attempt('previous')], KEY, 'exec-a', NOW).action, 'reconcile');
  const conflict = clean.map((row) => ({ ...row })); conflict[1].summaryMarkdown = 'checkpoint';
  assert.equal(preflightAI(conflict, [attempt('current'), attempt('previous')], KEY, 'exec-a', NOW).action, 'manual_review');
});
test('pre-AI only permits owned usable coverage and never all_failed', () => {
  const coverage = aggregateLogicalJobs(request(), [attempt('current'), attempt('previous')]);
  const claimed = request({ status: 'summary_dispatching', leaseOwner: 'exec-a', leaseUntilIso: LATER, coverageStatus: coverage.coverageStatus, availableRolesJson: JSON.stringify(coverage.availableRoles), missingRolesJson: JSON.stringify(coverage.missingRoles), failedLogicalJobKeysJson: JSON.stringify(coverage.failedLogicalJobKeys) });
  assert.equal(preflightAI([claimed], [attempt('current'), attempt('previous')], KEY, 'exec-a', NOW).action, 'ai');
  assert.throws(() => preflightAI([claimed], [attempt('current', { status: 'failed', dialogue: '' }), attempt('previous', { status: 'failed', dialogue: '' })], KEY, 'exec-a', NOW), /not usable/);
  assert.throws(() => preflightAI([claimed], [attempt('current'), attempt('previous')], KEY, 'other', NOW), /owner gate/);
});
test('preflight runtime wrapper calls pure validation and blocks pending, manual, failed, and coverage drift', () => {
  const coverage = aggregateLogicalJobs(request(), [attempt('current'), attempt('previous')]);
  const claimed = request({ status: 'summary_dispatching', leaseOwner: 'exec-a', leaseUntilIso: LATER, coverageStatus: coverage.coverageStatus, availableRolesJson: JSON.stringify(coverage.availableRoles), missingRolesJson: JSON.stringify(coverage.missingRoles), failedLogicalJobKeysJson: JSON.stringify(coverage.failedLogicalJobKeys) });
  assert.equal(runPreflightRuntime([claimed], [attempt('current'), attempt('previous')], KEY, 'exec-a', NOW)[0].action, 'ai');
  assert.throws(() => runPreflightRuntime([claimed], [attempt('current', { status: 'queued', dialogue: '' }), attempt('previous')], KEY, 'exec-a', NOW), /not usable/);
  assert.throws(() => runPreflightRuntime([claimed], [attempt('current', { status: 'manual_review', dialogue: '' }), attempt('previous')], KEY, 'exec-a', NOW), /not usable/);
  assert.throws(() => runPreflightRuntime([claimed], [attempt('current', { status: 'failed', dialogue: '' }), attempt('previous', { status: 'failed', dialogue: '' })], KEY, 'exec-a', NOW), /not usable/);
  assert.throws(() => runPreflightRuntime([{ ...claimed, availableRolesJson: '[]' }], [attempt('current'), attempt('previous')], KEY, 'exec-a', NOW), /persisted coverage mismatch/);
});
test('preflight preserves timed-out stream metadata as partial missing evidence', () => {
  const attempts = [attempt('current'), attempt('previous', { status: 'timed_out', dialogue: '' })];
  const coverage = aggregateLogicalJobs(request(), attempts);
  const claimed = request({
    status: 'summary_dispatching',
    leaseOwner: 'exec-a',
    leaseUntilIso: LATER,
    coverageStatus: coverage.coverageStatus,
    availableRolesJson: JSON.stringify(coverage.availableRoles),
    missingRolesJson: JSON.stringify(coverage.missingRoles),
    failedLogicalJobKeysJson: JSON.stringify(coverage.failedLogicalJobKeys),
  });
  const [result] = runPreflightRuntime([claimed], attempts, KEY, 'exec-a', NOW);
  assert.equal(result.action, 'ai');
  assert.equal(result.coverageStatus, 'partial');
  assert.deepEqual(result.availableRoles, ['current']);
  assert.deepEqual(result.missingRoles, ['previous']);
  assert.equal(result.streams[1].dialogue, '');
  assert.equal(result.streams[1].transcript.outcome, 'timed_out');
});
test('rejects malformed request context and corrupted attempt duplicate linkage', () => {
  assert.throws(() => validateRequestRows([request({ orderedStreamsJson: JSON.stringify([{ ...STREAMS[0], streamContext: [] }, STREAMS[1]]) })], KEY), /invalid ordered stream/);
  const corrupted = [attempt('current'), { ...attempt('current', { id: 203, canonicalRowID: 'wrong', reconciliationStatus: 'duplicate' }) }, attempt('previous')];
  assert.throws(() => aggregateLogicalJobs(request(), corrupted), /duplicate canonical linkage/);
  assert.throws(() => runPreflightRuntime([request({ createdAt: 'bad', status: 'summary_dispatching', leaseOwner: 'exec-a', leaseUntilIso: LATER })], [attempt('current'), attempt('previous')], KEY, 'exec-a', NOW), /invalid createdAt/);
});
test('AI input is a natural resolved allowlist without storage fields', () => {
  const aggregate = aggregateLogicalJobs(request(), [attempt('current'), attempt('previous', { status: 'failed', dialogue: '' })]);
  const input = buildSummaryInput(request({ leaseOwner: 'secret', reconciliationStatus: 'canonical' }), aggregate);
  assert.deepEqual(Object.keys(input), ['requestKey', 'requestType', 'channel', 'threadTS', 'coverageStatus', 'availableRoles', 'missingRoles', 'failedLogicalJobKeys', 'streams']);
  assert.equal(input.streams.length, 2);
  assert.deepEqual(input.streams.map(({ transcript }) => transcript.outcome), ['transcribed', 'failed']);
  assert.doesNotMatch(JSON.stringify(input), /leaseOwner|canonicalRowID|streamContextJson/);
});
test('manual resolution selects one checkpoint and identical earliest checkpoint', () => {
  assert.equal(planRequestResolution([manual(101), manual(102, 'ready', 'checkpoint')], { approved: true, approvalRef: 'P10-1', decisionID: 'd1' }).winnerRowID, 102);
  const plan = planRequestResolution([manual(101, 'ready', 'same'), manual(102, 'ready', 'same')], { approved: true, approvalRef: 'P10-2', decisionID: 'd2' });
  assert.equal(plan.selectionReason, 'identical_checkpoints_system_earliest'); assert.equal(plan.winnerRowID, 101);
});
test('manual conflicting checkpoint requires explicit winner and approval reference', () => {
  const rows = [manual(101, 'ready', 'one'), manual(102, 'ready', 'two')];
  assert.throws(() => planRequestResolution(rows, { approved: true, approvalRef: 'P10-3', decisionID: 'd3' }), /explicit winner/);
  assert.throws(() => planRequestResolution(rows, { approved: true, decisionID: 'd3', winnerRowID: '101' }), /approval reference/);
  assert.equal(planRequestResolution(rows, { approved: true, approvalRef: 'P10-3', decisionID: 'd3', winnerRowID: '102' }).winnerRowID, 102);
});
test('manual failed decision follows fixed canonical protocol without attempts', () => {
  const result = runRequestResolution([manual(101, 'ready', 'one'), manual(102, 'ready', 'two')], { approved: true, approvalRef: 'P10-4', decisionID: 'd4', decision: 'failed' });
  assert.equal(result.winner.status, 'failed'); assert.equal(result.winner.manualReviewResolution, 'request_failed:checkpoint_conflict'); assert.equal(result.sideEffectCalls, 0);
});
test('manual resolution restores all allowed original stages', () => {
  for (const stage of ['ready', 'summary_dispatching', 'summary_retry_pending', 'completed']) {
    const result = runRequestResolution([manual(101, stage, 'checkpoint'), manual(102, stage)], { approved: true, approvalRef: `P10-${stage}`, decisionID: `d-${stage}` });
    assert.equal(result.winner.status, stage); assert.equal(result.winner.manualReviewOriginalStage, stage);
  }
});
test('manual loser partial failure retries same immutable winner with zero side effects', () => {
  const rows = [manual(101, 'ready', 'same'), manual(102, 'ready', 'same'), manual(103, 'ready', 'same')];
  const approval = { approved: true, approvalRef: 'P10-5', decisionID: 'd5' };
  const first = runRequestResolution(rows, approval, { failLoserID: 103 });
  assert.equal(first.winner.status, 'manual_review'); assert.equal(first.winner.manualReviewResolution, '');
  const retry = runRequestResolution(first.rows, approval);
  assert.equal(retry.winner.id, 101); assert.ok(retry.losers.every((row) => row.reconciliationStatus === 'duplicate')); assert.equal(retry.sideEffectCalls, 0);
});
test('manual crash before final patch reuses fixed winner and finalizes invariant', () => {
  const rows = [manual(101, 'summary_dispatching', 'same'), manual(102, 'summary_dispatching', 'same')];
  const approval = { approved: true, approvalRef: 'P10-6', decisionID: 'd6' };
  const crash = runRequestResolution(rows, approval, { crashBeforeWinnerFinalPatch: true });
  assert.equal(crash.canonicalRows.length, 1); assert.equal(crash.winner.manualReviewResolution, '');
  assert.equal(crash.winner.manualResolutionWinnerRowID, '101');
  const retry = runRequestResolution(crash.rows, approval, { resolutionIso: NOW });
  assert.equal(retry.winner.status, 'summary_dispatching'); assert.equal(retry.winner.leaseUntilIso, NOW); assert.equal(retry.sideEffectCallsBeforeFinalPatch, 0);
});

const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflow.json'), 'utf8'));
const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
const successors = (name) => (workflow.connections[name]?.main || []).flat().map(({ node }) => node);
const reachable = (from, target, seen = new Set()) => {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return successors(from).some((next) => reachable(next, target, seen));
};
const conditionKeys = (name) => byName.get(name).parameters.filters.conditions.map(({ keyName }) => keyName);

test('workflow has the typed single request-key coordinator contract and authoritative tables', () => {
  assert.deepEqual(byName.get('Start').parameters.workflowInputs.values, [{ name: 'requestKey', type: 'string' }]);
  const tables = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.dataTable').map((node) => node.parameters.dataTableId.value);
  assert.ok(tables.every((name) => ['summary_requests_v3', 'stt_jobs_v3'].includes(name)));
  assert.equal(workflow.active, false);
  assert.equal(workflow.isArchived, false);
});

test('every Data Table update is exact, retained by alwaysOutputData, and immediately limited', () => {
  for (const node of workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.dataTable' && node.parameters.operation === 'update')) {
    assert.equal(node.alwaysOutputData, true, node.name);
    assert.equal(node.parameters.matchType, 'allConditions', node.name);
    assert.ok(conditionKeys(node.name).includes('id'), node.name);
    assert.ok(successors(node.name).every((next) => byName.get(next).type === 'n8n-nodes-base.limit'), node.name);
  }
});

test('Data Table system id filters remain numeric while canonical references stringify ids', () => {
  for (const node of workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.dataTable' && node.parameters.operation === 'update')) {
    const filters = Object.fromEntries(node.parameters.filters.conditions.map(({ keyName, keyValue }) => [keyName, keyValue]));
    if (filters.id) assert.doesNotMatch(filters.id, /String\(/, node.name);
    if (filters.canonicalRowID && /\$json\.id/.test(filters.canonicalRowID)) assert.match(filters.canonicalRowID, /String\(\$json\.id\)/, node.name);
  }
});

test('all request and attempt reads preserve zero-row execution for helper filtering', () => {
  for (const node of workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.dataTable' && node.parameters.operation === 'get')) {
    assert.equal(node.alwaysOutputData, true, node.name);
    assert.equal(node.parameters.returnAll, true, node.name);
  }
});

test('plan carriers are mutation-branch only and pair exactly with their update and Merge input 0', () => {
  const pairs = [
    ['Carry Initial Conflict', 'Freeze Competing Canonicals', 'Merge Initial Plan And Reread'],
    ['Carry Initial Reconcile', 'Apply Request Reconciliation', 'Merge Initial Plan And Reread'],
    ['Carry Coverage Ready', 'Write Terminal Coverage Ready', 'Merge Coverage Ready Plan And Reread'],
    ['Carry Coverage Failure', 'Fail All Failed Request', 'Merge Coverage Failure Plan And Reread'],
    ['Carry Claim-Time Conflict', 'Freeze Claim-Time Canonicals', 'Merge Claim-Time Plan And Reread'],
    ['Carry Claim-Time Reconcile', 'Apply Claim-Time Reconciliation', 'Merge Claim-Time Plan And Reread'],
    ['Carry Initial Claim Plan', 'Claim Initial Exact', 'Merge Claim Plan And Reread'],
    ['Carry Retry Claim Plan', 'Claim Retry Due Exact', 'Merge Claim Plan And Reread'],
    ['Carry Expired Claim Plan', 'Claim Expired Exact', 'Merge Claim Plan And Reread'],
    ['Carry Pre-AI Reconcile', 'Apply Pre-AI Reconciliation', 'Merge Pre-AI Plan And Reread'],
    ['Carry Pre-AI Conflict', 'Freeze Pre-AI Canonicals', 'Merge Pre-AI Plan And Reread'],
  ];
  for (const [carrier, update, merge] of pairs) {
    const outputs = workflow.connections[carrier].main[0];
    assert.deepEqual(outputs.map(({ node }) => node), [update, merge], carrier);
    assert.equal(outputs[1].index, 0, carrier);
    assert.equal(byName.get(update).type, 'n8n-nodes-base.dataTable', carrier);
  }
});

test('every mutation is immediately limited and each reread reaches only its Merge input 1', () => {
  const pairs = [
    ['Freeze Competing Canonicals', 'Limit Conflict Patch', 'Re-read Frozen Request', 'Merge Initial Plan And Reread'],
    ['Apply Request Reconciliation', 'Limit Reconciliation Patch', 'Re-read Reconciled Request', 'Merge Initial Plan And Reread'],
    ['Write Terminal Coverage Ready', 'Limit Coverage Patch', 'Re-read Coverage Request', 'Merge Coverage Ready Plan And Reread'],
    ['Fail All Failed Request', 'Limit Failure Patch', 'Re-read Failed Request', 'Merge Coverage Failure Plan And Reread'],
    ['Freeze Claim-Time Canonicals', 'Limit Claim-Time Conflict', 'Re-read Claim-Time Frozen Request', 'Merge Claim-Time Plan And Reread'],
    ['Apply Claim-Time Reconciliation', 'Limit Claim-Time Reconciliation', 'Re-read Claim-Time Reconciliation', 'Merge Claim-Time Plan And Reread'],
    ['Claim Initial Exact', 'Limit Claim', 'Re-read Claimed Request', 'Merge Claim Plan And Reread'],
    ['Claim Retry Due Exact', 'Limit Claim', 'Re-read Claimed Request', 'Merge Claim Plan And Reread'],
    ['Claim Expired Exact', 'Limit Claim', 'Re-read Claimed Request', 'Merge Claim Plan And Reread'],
    ['Apply Pre-AI Reconciliation', 'Limit Pre-AI Reconciliation', 'Re-read Pre-AI Reconciliation', 'Merge Pre-AI Plan And Reread'],
    ['Freeze Pre-AI Canonicals', 'Limit Pre-AI Conflict', 'Re-read Pre-AI Frozen Request', 'Merge Pre-AI Plan And Reread'],
  ];
  for (const [write, limit, reread, merge] of pairs) {
    assert.deepEqual(successors(write), [limit], write);
    assert.deepEqual(successors(limit), [reread], limit);
    assert.deepEqual(workflow.connections[reread].main[0], [{ node: merge, type: 'main', index: 1 }], reread);
  }
});

test('every plan Merge is append v3.2 and has exactly one verifier', () => {
  const verifiers = new Map([
    ['Merge Initial Plan And Reread', 'Verify Request Reconciliation'],
    ['Merge Coverage Ready Plan And Reread', 'Verify Request Write'],
    ['Merge Coverage Failure Plan And Reread', 'Verify All Failed Request'],
    ['Merge Claim-Time Plan And Reread', 'Verify Claim-Time Reconciliation'],
    ['Merge Claim Plan And Reread', 'Verify Claimed Owner'],
    ['Merge Pre-AI Plan And Reread', 'Verify Pre-AI Reconciliation'],
  ]);
  for (const [merge, verifier] of verifiers) {
    const node = byName.get(merge);
    assert.deepEqual(node.parameters, { mode: 'append', numberInputs: 2 }, merge);
    assert.equal(node.typeVersion, 3.2, merge);
    assert.deepEqual(successors(merge), [verifier], merge);
  }
});

test('three exact claim branches are reachable and retain their plan lease snapshots', () => {
  for (const name of ['Claim Initial Exact', 'Claim Retry Due Exact', 'Claim Expired Exact']) {
    const keys = conditionKeys(name);
    assert.ok(['id', 'requestKey', 'status', 'reconciliationStatus', 'canonicalRowID', 'leaseOwner', 'leaseUntilIso'].every((key) => keys.includes(key)), name);
    assert.deepEqual(successors(name), ['Limit Claim']);
    assert.ok(reachable('Start', name));
    assert.match(JSON.stringify(byName.get(name).parameters.columns.value), /leaseUntilIso/);
  }
  assert.ok(conditionKeys('Claim Retry Due Exact').includes('nextRetryAtIso'));
});

test('claim and routing switches use an explicit extra fallback terminal', () => {
  for (const name of ['Route Initial Reconciliation', 'Route Coverage Write', 'Route Claim Reconciliation', 'Select Exact Claim Branch', 'Route Preflight AI']) {
    const node = byName.get(name);
    const fallbackIndex = node.parameters.rules.values.length;
    assert.equal(node.parameters.options.fallbackOutput, 'extra', name);
    assert.equal(successors(name)[fallbackIndex], 'Drop Side Effect Output', name);
  }
});

test('noop and fallback outputs cannot reach a carrier or Merge', () => {
  const terminals = ['Route Initial Reconciliation', 'Route Coverage Write', 'Route Claim Reconciliation', 'Select Exact Claim Branch', 'Route Preflight AI'];
  const guarded = workflow.nodes.filter(({ name }) => name.startsWith('Carry ') || name.startsWith('Merge ')).map(({ name }) => name);
  for (const router of terminals) {
    const output = byName.get(router).parameters.rules.values.length;
    const target = workflow.connections[router].main[output][0].node;
    assert.equal(target, 'Drop Side Effect Output', router);
    for (const node of guarded) assert.equal(reachable(target, node), false, `${router} -> ${node}`);
  }
});

test('initial all_failed aggregate reaches failure planning and cannot reach claim or AI', () => {
  const route = byName.get('Route Initial Reconciliation');
  assert.equal(route.parameters.rules.values.length, 4);
  assert.equal(successors('Route Initial Reconciliation')[3], 'Plan Coverage Write');
  assert.ok(reachable('Plan Coverage Write', 'Fail All Failed Request'));
  assert.equal(reachable('Verify All Failed Request', 'Plan Summary Claim'), false);
  assert.equal(reachable('Verify All Failed Request', 'Run AI Summary'), false);
});

test('claim-time reconciliation blocks all claim branches until one verified canonical is ready', () => {
  assert.deepEqual(successors('Read Request For Claim'), ['Plan Claim Reconciliation']);
  assert.deepEqual(successors('Plan Claim Reconciliation'), ['Route Claim Reconciliation']);
  assert.deepEqual(successors('Route Claim Reconciliation').slice(0, 3), ['Carry Claim-Time Conflict', 'Carry Claim-Time Reconcile', 'Plan Summary Claim']);
  assert.deepEqual(successors('Verify Claim-Time Reconciliation'), ['Read Request For Claim']);
});

test('verifiers use only direct carrier and reread inputs, never named execution state', () => {
  for (const file of ['Verify_Initial_Plan', 'Verify_Preflight_Plan', 'Verify_Claim_Time_Plan', 'Verify_Request_Write', 'Verify_Claim']) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'nodes', file, 'jsCode.js'), 'utf8');
    assert.doesNotMatch(code, /\$\('(?:Planner|Apply|Freeze)/, file);
    assert.doesNotMatch(code, /\.isExecuted/, file);
    assert.doesNotMatch(code, /\$\(/, file);
    assert.doesNotMatch(code, /\$runIndex/, file);
  }
});

test('coverage loop back to initial reconciliation preserves the direct carrier split contract', () => {
  const carrier = { id: 101, requestKey: KEY, action: 'write_ready', __planCarrier: true, __planPhase: 'coverage', __planAction: 'write_ready', desired: { status: 'ready' } };
  const row = request({ status: 'ready' });
  const { plan, rows } = splitCoverageCarrierAndRows([carrier, row]);
  assert.equal(plan.action, 'write_ready');
  assert.deepEqual(rows, [row]);
  assert.deepEqual(successors('Verify Request Write'), ['Read All Request Rows']);
});

test('preflight and build runtime use pure verified aggregate without parallel election or loose recomputation', () => {
  const preflightCode = fs.readFileSync(path.join(__dirname, '..', 'nodes', 'Preflight_AI', 'jsCode.js'), 'utf8');
  const buildCode = fs.readFileSync(path.join(__dirname, '..', 'nodes', 'Build_Summary_Input', 'jsCode.js'), 'utf8');
  assert.match(preflightCode, /const result = preflightAI\(/);
  assert.doesNotMatch(preflightCode, /localeCompare/);
  assert.match(buildCode, /buildSummaryInput\(\$json, \$json\)/);
  assert.doesNotMatch(buildCode, /Re-read Attempts Before AI/);
});

test('waiting_stt coverage is exact-patched to ready before any claim planning', () => {
  assert.ok(conditionKeys('Write Terminal Coverage Ready').includes('status'));
  assert.equal(byName.get('Write Terminal Coverage Ready').parameters.columns.value.status, 'ready');
  assert.ok(reachable('Write Terminal Coverage Ready', 'Verify Request Write'));
  assert.ok(reachable('Verify Request Write', 'Plan Summary Claim'));
});

test('all-failed writes a fixed failure, verifies it, and cannot reach AI', () => {
  assert.equal(byName.get('Fail All Failed Request').parameters.columns.value.errorCode, 'SUMMARY_ALL_STT_LOGICAL_JOBS_FAILED');
  assert.deepEqual(successors('Verify All Failed Request'), ['Drop Side Effect Output']);
  assert.equal(reachable('Verify All Failed Request', 'Run AI Summary'), false);
});

test('pre-AI repeats full request reconciliation and reacquires the verified owner gate', () => {
  assert.ok(reachable('Verify Claimed Owner', 'Re-read Request Before AI'));
  assert.ok(reachable('Re-read Request Before AI', 'Preflight AI'));
  assert.deepEqual(successors('Verify Pre-AI Reconciliation'), ['Re-read Request Before AI']);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'nodes', 'Preflight_AI', 'jsCode.js'), 'utf8'), /pre-AI owner gate failed/);
});

test('AI dispatch uses the exact natural allowlist, fire-and-forget selector, and empty sink', () => {
  const ai = byName.get('Run AI Summary');
  assert.equal(ai.parameters.workflowId.value, 'AISummaryV3A0001');
  assert.equal(ai.parameters.workflowId.cachedResultName, 'AI SUMMARY v3');
  assert.equal(ai.parameters.options.waitForSubWorkflow, false);
  assert.deepEqual(Object.keys(ai.parameters.workflowInputs.value), ['requestKey', 'requestType', 'channel', 'threadTS', 'coverageStatus', 'availableRoles', 'missingRoles', 'failedLogicalJobKeys', 'streams']);
  assert.deepEqual(successors('Run AI Summary'), ['Drop Side Effect Output']);
});

test('all reconciliation verifiers terminalize verified freezes and only emit a canonical for reconcile', () => {
  const verifiers = [
    ['initial', 'Verify Request Reconciliation', 'Plan Summary Claim', verifyInitialCarrierInput],
    ['claim-time', 'Verify Claim-Time Reconciliation', 'Plan Summary Claim', verifyClaimTimeCarrierInput],
    ['pre-ai', 'Verify Pre-AI Reconciliation', 'Run AI Summary', verifyPreflightCarrierInput],
  ];
  for (const [phase, node, blockedTarget, verifyCarrierInput] of verifiers) {
    const carrier = (id, action, extra = {}) => ({ id, requestKey: KEY, action, __planCarrier: true, __planPhase: phase, __planAction: action, ...extra });
    const frozen = (id) => request({ id, canonicalRowID: id, status: 'manual_review', manualReviewReason: 'multiple_canonical_checkpoint_conflict' });
    const frozenOutput = verifyCarrierInput([
      carrier(101, 'manual_review'), carrier(102, 'manual_review'),
      frozen(101), frozen(102),
    ], phase);
    assert.deepEqual(frozenOutput, [], `${phase} manual freeze`);
    assert.equal(frozenOutput.length > 0 && reachable(node, blockedTarget), false, `${phase} freeze cannot reach ${blockedTarget}`);
    const canonical = request();
    assert.deepEqual(verifyCarrierInput([
      carrier(101, 'reconcile', { desiredReconciliationStatus: 'canonical', desiredCanonicalRowID: '101' }),
      carrier(102, 'reconcile', { desiredReconciliationStatus: 'duplicate', desiredCanonicalRowID: '101' }),
      canonical,
      request({ id: 102, reconciliationStatus: 'duplicate', canonicalRowID: '101' }),
    ], phase), [canonical], `${phase} reconcile`);
    assert.ok(successors(node).length > 0, node);
  }
  assert.equal(byName.has('Claim Initial Summary'), false);
});

test('no path can call AI before a verified soft-CAS claim', () => {
  assert.ok(reachable('Verify Claimed Owner', 'Run AI Summary'));
  assert.equal(reachable('Read All Request Rows', 'Run AI Summary'), true);
  assert.deepEqual(successors('Build Summary Input'), ['Run AI Summary']);
  assert.ok(reachable('Limit Claim', 'Verify Claimed Owner'));
});

test('workflow has valid UUIDv4 IDs, external helpers, valid connection targets, and no dead nodes', () => {
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const names = new Set(workflow.nodes.map(({ name }) => name));
  assert.ok(workflow.nodes.every(({ id }) => uuidV4.test(id)));
  assert.equal(new Set(workflow.nodes.map(({ id }) => id)).size, workflow.nodes.length);
  for (const targets of Object.values(workflow.connections)) for (const output of targets.main || []) for (const target of output) assert.ok(names.has(target.node));
  for (const node of workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.code')) {
    const ref = node.parameters.jsCode;
    assert.match(ref, /^__EXTERNAL_FILE__:\/\//, node.name);
    assert.ok(fs.existsSync(path.join(__dirname, '..', ref.replace('__EXTERNAL_FILE__://', ''))), node.name);
  }
  const seen = new Set();
  const walk = (name) => { if (seen.has(name)) return; seen.add(name); successors(name).forEach(walk); };
  walk('Start');
  assert.deepEqual([...names].filter((name) => !seen.has(name)), []);
  assert.deepEqual(workflow.settings, { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true, saveExecutionProgress: false });
});

test('runtime Code sources contain no sibling require', () => {
  for (const node of workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.code')) {
    const source = fs.readFileSync(path.join(__dirname, '..', node.parameters.jsCode.replace('__EXTERNAL_FILE__://', '')), 'utf8');
    assert.doesNotMatch(source, /require\(['"]\.\.?\//, node.name);
  }
});
