const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  collectDataTableReferences,
  remapDataTableReferences,
} = require('../../../scripts/deploy-utils');

const workflowDir = path.resolve(__dirname, '..');
const workflowPath = path.join(workflowDir, 'workflow.json');
const normalizePath = path.join(workflowDir, 'nodes', 'Normalize_Callback', 'jsCode.js');
const validateHashPath = path.join(workflowDir, 'nodes', 'Validate_Hash_Rows', 'jsCode.js');
const classifyPath = path.join(workflowDir, 'nodes', 'Classify_Claim', 'jsCode.js');
const reconcilePath = path.join(workflowDir, 'nodes', 'Reconcile_Canonical', 'jsCode.js');
const verifyPath = path.join(workflowDir, 'nodes', 'Verify_Callback_State', 'jsCode.js');
const verifyLogicalPath = path.join(workflowDir, 'nodes', 'Verify_Logical_Winner', 'jsCode.js');

const { normalizeCallback } = require(normalizePath);
const { validateHashRows } = require(validateHashPath);
const { MAX_AUTOMATIC_ATTEMPTS, classifyClaim } = require(classifyPath);
const {
  ATTEMPT_CHECKPOINT_FIELDS,
  SUMMARY_CHECKPOINT_FIELDS,
  planCanonicalReconciliation,
} = require(reconcilePath);
const { verifyCallbackState, verifyFrozenConflict } = require(verifyPath);
const { verifyLogicalWinner } = require(verifyLogicalPath);

const NOW = '2026-08-22T00:10:00.000Z';
const TOKEN = 'a'.repeat(64);
const HASH = 'b'.repeat(64);
const ATTEMPT_KEY = 'summary:req-001:current:9001:fromStart:1';
const LOGICAL_JOB_KEY = 'summary:req-001:current:9001:fromStart';
const RETRY_SLOT_MINUTES = [1, 2, 4, 6, 9, 13, 18, 25, 35, 48, 65, 88, 118, 158, 211, 281, 374, 497, 660];
const P3_IDS = new Map([
  ['suspect_stt_candidates_v3', 'p3-suspects'],
  ['stt_jobs_v3', 'p3-jobs'],
  ['summary_requests_v3', 'p3-summaries'],
  ['automation_errors_v3', 'p3-errors'],
]);

function callbackContext(overrides = {}) {
  return {
    attemptKey: ATTEMPT_KEY,
    logicalJobKey: LOGICAL_JOB_KEY,
    requestKey: 'summary:req-001',
    requestType: 'suspect',
    streamID: '9001',
    mode: 'fromStart',
    channel: 'C0A4JJJKJMD',
    threadTS: '1787364000.000001',
    processingMessageTS: '1787364001.000002',
    callbackToken: TOKEN,
    ...overrides,
  };
}

function callbackBody(overrides = {}) {
  return {
    statusCode: 200,
    transcription: 'hello world',
    languages: ['en'],
    webhook: { context: callbackContext() },
    ...overrides,
  };
}

function normalized(overrides = {}) {
  const result = normalizeCallback({ body: callbackBody() });
  assert.equal(result.valid, true);
  return { ...result, ...overrides };
}

function attempt(overrides = {}) {
  const attemptNumber = Number(overrides.attempt || 1);
  const result = {
    id: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:05:00.000Z',
    attemptKey: ATTEMPT_KEY,
    logicalJobKey: LOGICAL_JOB_KEY,
    requestKey: 'summary:req-001',
    requestType: 'suspect',
    attempt: 1,
    role: 'current',
    streamID: '9001',
    mode: 'fromStart',
    status: 'waiting_callback',
    callbackTokenHash: HASH,
    callbackTokenExpiresAtIso: '2026-08-23T00:00:00.000Z',
    callbackDeadlineAtIso: attemptNumber <= RETRY_SLOT_MINUTES.length
      ? new Date(Date.parse(NOW) + RETRY_SLOT_MINUTES[attemptNumber - 1] * 60_000).toISOString()
      : attemptNumber === MAX_AUTOMATIC_ATTEMPTS ? '2026-08-22T12:10:00.000Z' : '2026-08-23T00:10:00.000Z',
    consumedAtIso: '',
    channel: 'C0A4JJJKJMD',
    threadTS: '1787364000.000001',
    processingMessageTS: '1787364001.000002',
    dialogue: '',
    language: '',
    errorCode: '',
    nextRetryAtIso: '',
    presentationStatus: 'pending',
    manualReviewResolution: '',
    reconciliationStatus: 'canonical',
    canonicalRowID: '1',
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'canonicalRowID')) result.canonicalRowID = String(result.id);
  return result;
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
  return Object.fromEntries(node.parameters.filters.conditions.map((condition) => [condition.keyName, condition]));
}

function reachableNodes(workflow, start) {
  const seen = new Set();
  const pending = [start];
  while (pending.length > 0) {
    const source = pending.pop();
    for (const output of workflow.connections[source]?.main || []) {
      for (const { node } of output || []) {
        if (!seen.has(node)) {
          seen.add(node);
          pending.push(node);
        }
      }
    }
  }
  return seen;
}

test('normalizes only body.webhook.context in object or key/value-array form', () => {
  const objectResult = normalizeCallback({ body: callbackBody() });
  assert.equal(objectResult.valid, true);
  assert.deepEqual(objectResult.context, callbackContext());
  assert.equal(objectResult.transcription, 'hello world');
  assert.equal(objectResult.language, 'en');

  const entries = Object.entries(callbackContext()).map(([key, value]) => ({ key, value }));
  const arrayResult = normalizeCallback({ body: callbackBody({ webhook: { context: entries } }) });
  assert.deepEqual(arrayResult.context, callbackContext());

  const vdsEntries = Object.entries(callbackContext()).map(([Key, Value]) => ({ Key, Value }));
  const vdsArrayResult = normalizeCallback({ body: callbackBody({ webhook: { context: vdsEntries } }) });
  assert.deepEqual(vdsArrayResult.context, callbackContext());

  for (const item of [
    { body: { ...callbackBody(), webhook: undefined, callbackToken: TOKEN } },
    { body: { ...callbackBody(), webhook: { context: { ...callbackContext(), extra: 'x' } } } },
    { body: { ...callbackBody(), webhook: { context: [...entries, entries[0]] } } },
    { body: { ...callbackBody(), webhook: { context: [{ Key: 'attemptKey', value: 'mixed' }, ...vdsEntries.slice(1)] } } },
    { body: { ...callbackBody(), webhook: { context: callbackContext({ mode: 'first' }) } } },
    { body: { ...callbackBody(), webhook: { context: callbackContext({ channel: 'C09F0SYG57D' }) } } },
    { body: { ...callbackBody(), webhook: { context: callbackContext({ callbackToken: 'ABC' }) } } },
    { body: { ...callbackBody(), transcription: [] } },
  ]) {
    const result = normalizeCallback(item);
    assert.equal(result.valid, false);
    assert.equal(result.responseClass, 'malformed');
    assert.equal(result.httpStatus, 400);
    assert.equal('callbackToken' in result, false);
    assert.equal('body' in result, false);
  }
});

test('normalizes numeric and string status codes only for integer 100 through 599', () => {
  for (const value of [100, 599, '100', '599']) {
    const result = normalizeCallback({ body: callbackBody({ statusCode: value }) });
    assert.equal(result.valid, true, String(value));
    assert.equal(result.statusCode, Number(value), String(value));
  }
  for (const value of [99, 600, '099', '600', 200.5, NaN, Infinity, -Infinity]) {
    const result = normalizeCallback({ body: callbackBody({ statusCode: value }) });
    assert.equal(result.valid, false, String(value));
    assert.equal(result.httpStatus, 400, String(value));
  }
});

test('accepts a first successful claim before strict TTL expiry', () => {
  const result = classifyClaim([attempt()], normalized(), HASH, NOW, [attempt()]);
  assert.equal(result.action, 'claim');
  assert.equal(result.responseClass, 'accepted');
  assert.equal(result.httpStatus, 202);
  assert.equal(result.expectedStatus, 'waiting_callback');
  assert.equal(result.desiredStatus, 'completed');
  assert.equal(result.dialogue, 'hello world');
  assert.equal(result.language, 'en');
  assert.equal(result.consumedAtIso, NOW);
  assert.equal(result.callbackTokenHash, HASH);
});

test('treats same-provenance consumed callbacks as duplicate without result overwrite', () => {
  const row = attempt({
    status: 'completed',
    consumedAtIso: '2026-08-22T00:09:00.000Z',
    dialogue: 'persisted result',
    language: 'ja',
  });
  const result = classifyClaim([row], normalized({ transcription: 'replacement' }), HASH, NOW, [row]);
  assert.deepEqual(result, {
    action: 'duplicate',
    responseClass: 'duplicate',
    httpStatus: 200,
    attemptKey: ATTEMPT_KEY,
    requestKey: 'summary:req-001',
    logicalJobKey: LOGICAL_JOB_KEY,
    reason: 'already_consumed',
  });
});

test('rejects consumed wrong provenance and all unconsumed provenance mismatches', () => {
  for (const [field, value] of [
    ['attemptKey', `${ATTEMPT_KEY}-other`],
    ['logicalJobKey', `${LOGICAL_JOB_KEY}-other`],
    ['requestKey', 'summary:req-other'],
    ['requestType', 'standalone_stt'],
    ['streamID', '9002'],
    ['mode', 'fromEnd'],
    ['threadTS', 'other'],
    ['processingMessageTS', 'other'],
  ]) {
    const bad = normalized({ context: callbackContext({ [field]: value }) });
    const result = classifyClaim([attempt({ consumedAtIso: NOW })], bad, HASH, NOW);
    assert.equal(result.action, 'reject', field);
    assert.equal(result.httpStatus, 400, field);
    assert.equal(result.reason, 'provenance_mismatch', field);
  }
});

test('uses exact persisted hash and strict expiresAt greater-than-now', () => {
  const mismatch = classifyClaim([attempt()], normalized(), 'c'.repeat(64), NOW);
  assert.equal(mismatch.action, 'reject');
  assert.equal(mismatch.httpStatus, 401);
  assert.equal(mismatch.reason, 'invalid_token');

  for (const expiresAt of [NOW, '2026-08-22T00:09:59.999Z']) {
    const expired = classifyClaim([attempt({ callbackTokenExpiresAtIso: expiresAt })], normalized(), HASH, NOW);
    assert.equal(expired.action, 'reject');
    assert.equal(expired.httpStatus, 400);
    assert.equal(expired.reason, 'expired_token');
  }
  assert.throws(
    () => classifyClaim([attempt({ callbackTokenExpiresAtIso: 'not-an-iso' })], normalized(), HASH, NOW),
    /invalid token expiry/i,
  );
});

test('validates every meaningful hash lookup row before selecting an attempt', () => {
  assert.deepEqual(validateHashRows([{}], HASH), { found: false });
  assert.deepEqual(validateHashRows([attempt(), attempt({ id: 2 })], HASH), {
    found: true,
    attemptKey: ATTEMPT_KEY,
  });

  for (const rows of [
    [attempt({ callbackTokenHash: 'c'.repeat(64) })],
    [attempt(), attempt({ id: 2, attemptKey: 'other-attempt' })],
    [attempt({ requestKey: '' })],
    [attempt({ callbackTokenHash: undefined })],
  ]) {
    assert.throws(() => validateHashRows(rows, HASH), /invalid token hash lookup/i);
  }

  for (const [field, value] of [
    ['logicalJobKey', `${LOGICAL_JOB_KEY}-drift`],
    ['requestKey', 'summary:req-drift'],
    ['requestType', 'standalone_stt'],
    ['role', 'previous'],
    ['streamID', '9002'],
    ['mode', 'fromEnd'],
    ['channel', 'C09F0SYG57D'],
    ['threadTS', '1787364000.999999'],
    ['processingMessageTS', '1787364001.999999'],
  ]) {
    assert.throws(
      () => validateHashRows([attempt(), attempt({ id: 2, [field]: value })], HASH),
      /invalid token hash lookup/i,
      field,
    );
  }
});

test('allows unresolved manual review and a valid old attempt to complete', () => {
  const manual = classifyClaim([
    attempt({ status: 'manual_review', callbackDeadlineAtIso: '' }),
  ], normalized(), HASH, NOW);
  assert.equal(manual.action, 'claim');
  assert.equal(manual.desiredStatus, 'completed');
  assert.equal(manual.expectedManualReviewResolution, '');

  const old = attempt({ attempt: 1 });
  const newer = attempt({
    id: 2,
    canonicalRowID: '2',
    attemptKey: `${LOGICAL_JOB_KEY}:2`,
    attempt: 2,
    status: 'waiting_callback',
    callbackTokenHash: 'd'.repeat(64),
  });
  const result = classifyClaim([old], normalized(), HASH, NOW, [old, newer]);
  assert.equal(result.desiredStatus, 'completed');

  const resolved = classifyClaim(
    [attempt({ status: 'manual_review', manualReviewResolution: 'retry_created:next' })],
    normalized(),
    HASH,
    NOW,
  );
  assert.equal(resolved.action, 'reject');
  assert.equal(resolved.httpStatus, 409);
});

test('classifies every unresolved manual-review callback as terminal across automatic and manual attempts', () => {
  for (const attemptNumber of [1, 20, 21]) {
    const row = attempt({
      attempt: attemptNumber,
      status: 'manual_review',
      callbackDeadlineAtIso: '2026-08-22T00:20:00.000Z',
      manualReviewResolution: '',
    });
    const success = classifyClaim([row], normalized(), HASH, NOW);
    assert.equal(success.desiredStatus, 'completed', `success attempt ${attemptNumber}`);
    assert.equal(success.nextRetryAtIso, '', `success attempt ${attemptNumber}`);

    const empty = classifyClaim([row], normalized({ transcription: '' }), HASH, NOW);
    assert.equal(empty.desiredStatus, 'completed', `empty attempt ${attemptNumber}`);
    assert.equal(empty.errorCode, 'callback_empty_transcription', `empty attempt ${attemptNumber}`);

    for (const callback of [
      normalized({ retryableServiceError: true }),
      normalized({ statusCode: 400, transcription: 'service response' }),
    ]) {
      const result = classifyClaim([row], callback, HASH, NOW);
      assert.equal(result.desiredStatus, 'failed', `failure attempt ${attemptNumber}`);
      assert.equal(result.nextRetryAtIso, '', `failure attempt ${attemptNumber}`);
    }

    const deadline = classifyClaim([
      { ...row, callbackDeadlineAtIso: NOW },
    ], normalized(), HASH, NOW);
    assert.equal(deadline.desiredStatus, 'completed', `deadline attempt ${attemptNumber}`);
    assert.equal(deadline.nextRetryAtIso, '', `deadline attempt ${attemptNumber}`);
  }
});

test('does not consume an old callback after another attempt completed the logical job', () => {
  const old = attempt();
  const winner = attempt({
    id: 2,
    canonicalRowID: '2',
    attemptKey: `${LOGICAL_JOB_KEY}:2`,
    attempt: 2,
    status: 'completed',
    consumedAtIso: '2026-08-22T00:08:00.000Z',
    dialogue: 'winner result',
    callbackTokenHash: 'd'.repeat(64),
  });
  const result = classifyClaim([old], normalized(), HASH, NOW, [old, winner]);
  assert.equal(result.action, 'duplicate');
  assert.equal(result.reason, 'logical_job_already_completed');
});

test('fails closed on immutable logical provenance drift before and after consumption', () => {
  const current = attempt();
  const earlier = attempt({
    id: 2,
    canonicalRowID: '2',
    attemptKey: `${LOGICAL_JOB_KEY}:2`,
    attempt: 2,
    callbackTokenHash: 'd'.repeat(64),
    status: 'completed',
    consumedAtIso: '2026-08-22T00:08:00.000Z',
    dialogue: 'earlier result',
  });
  const sameProvenance = classifyClaim([current], normalized(), HASH, NOW, [current, earlier]);
  assert.equal(sameProvenance.action, 'duplicate');
  assert.equal(sameProvenance.reason, 'logical_job_already_completed');

  const expected = classifyClaim([current], normalized(), HASH, NOW, [current]);
  const applied = attempt({
    status: 'completed', consumedAtIso: NOW, dialogue: 'hello world', language: 'en',
  });
  const verified = verifyCallbackState([applied], expected);
  assert.equal(verifyLogicalWinner([applied, earlier], verified, expected).action, 'duplicate');

  for (const [field, value] of [
    ['logicalJobKey', `${LOGICAL_JOB_KEY}-drift`],
    ['requestKey', 'summary:req-drift'],
    ['requestType', 'standalone_stt'],
    ['role', 'previous'],
    ['streamID', '9002'],
    ['mode', 'fromEnd'],
    ['channel', 'C09F0SYG57D'],
    ['threadTS', '1787364000.999999'],
    ['processingMessageTS', '1787364001.999999'],
  ]) {
    const drifted = { ...earlier, [field]: value };
    assert.throws(
      () => classifyClaim([current], normalized(), HASH, NOW, [current, drifted]),
      /logical provenance|logical job row integrity/i,
      `pre-consumption ${field}`,
    );
    assert.throws(
      () => verifyLogicalWinner([applied, drifted], verified, expected),
      /logical provenance|logical job row integrity/i,
      `post-consumption ${field}`,
    );
  }

  const duplicateDrift = {
    ...current,
    id: 2,
    reconciliationStatus: 'duplicate',
    canonicalRowID: String(current.id),
    role: 'previous',
  };
  assert.throws(
    () => classifyClaim([current], normalized(), HASH, NOW, [current, duplicateDrift]),
    /logical provenance/i,
  );
  assert.throws(
    () => verifyLogicalWinner([applied, duplicateDrift], verified, expected),
    /logical provenance/i,
  );
  assert.throws(
    () => classifyClaim([attempt({ role: '' })], normalized(), HASH, NOW),
    /invalid immutable logical provenance/i,
  );
});

test('accepts empty transcription while retrying service errors by the persisted absolute slot', () => {
  assert.equal(MAX_AUTOMATIC_ATTEMPTS, 20);
  for (const attemptNumber of Array.from({ length: 20 }, (_, index) => index + 1)) {
    const row = attempt({ attempt: attemptNumber });
    const empty = classifyClaim([row], normalized({ transcription: '' }), HASH, NOW);
    const service = classifyClaim([row], normalized({ retryableServiceError: true }), HASH, NOW);
    assert.equal(empty.desiredStatus, 'completed');
    assert.equal(empty.errorCode, 'callback_empty_transcription');
    assert.equal(empty.dialogue, '');
    assert.equal(empty.nextRetryAtIso, '');
    assert.equal(empty.desiredPresentationStatus, 'completed');
    if (attemptNumber < 6) {
      assert.equal(service.desiredStatus, 'retry_pending');
      assert.equal(service.nextRetryAtIso, row.callbackDeadlineAtIso);
    } else {
      assert.equal(service.desiredStatus, 'failed');
    }

    const successfulAtDeadline = classifyClaim([
      attempt({ attempt: attemptNumber, callbackDeadlineAtIso: NOW }),
    ], normalized(), HASH, NOW);
    assert.equal(successfulAtDeadline.desiredStatus, 'completed');
  }

  const manual = classifyClaim([attempt({ attempt: 21 })], normalized({ transcription: '' }), HASH, NOW);
  assert.equal(manual.desiredStatus, 'completed');
  assert.equal(manual.errorCode, 'callback_empty_transcription');
  assert.equal(manual.nextRetryAtIso, '');
});

test('standalone STT keeps the twenty-attempt callback retry policy', () => {
  const standalone = (attemptNumber) => attempt({ attempt: attemptNumber, requestType: 'standalone_stt' });
  const standaloneCallback = normalized({ context: callbackContext({ requestType: 'standalone_stt' }), retryableServiceError: true });
  assert.equal(classifyClaim([standalone(6)], standaloneCallback, HASH, NOW).desiredStatus, 'retry_pending');
  assert.equal(classifyClaim([standalone(20)], standaloneCallback, HASH, NOW).desiredStatus, 'failed');
});

test('preserves canonical permanence and freezes cross-table checkpoint conflicts', () => {
  const existing = attempt({ id: 26, canonicalRowID: '26' });
  const later = attempt({
    id: 1,
    createdAt: '2026-08-22T00:01:00.000Z',
    reconciliationStatus: 'pending',
    canonicalRowID: '',
  });
  assert.equal(planCanonicalReconciliation([existing, later]).winnerRowID, 26);

  const clean = [
    attempt({ id: 2, canonicalRowID: '2', status: 'queued', callbackDeadlineAtIso: '' }),
    attempt({ id: 1, canonicalRowID: '1', status: 'queued', callbackDeadlineAtIso: '' }),
  ];
  const cleanPlan = planCanonicalReconciliation(clean, []);
  assert.equal(cleanPlan.action, 'reconcile');
  assert.equal(cleanPlan.winnerRowID, 1);
  assert.deepEqual(cleanPlan.mutations.map(({ id }) => id), [2]);

  for (const checkpoint of ATTEMPT_CHECKPOINT_FIELDS) {
    const rows = clean.map((row) => ({ ...row }));
    rows[1][checkpoint] = `${checkpoint}-value`;
    assert.equal(planCanonicalReconciliation(rows, []).action, 'manual_review', checkpoint);
  }
  for (const checkpoint of SUMMARY_CHECKPOINT_FIELDS) {
    const summaries = [{ requestKey: 'summary:req-001', [checkpoint]: `${checkpoint}-value` }];
    assert.equal(planCanonicalReconciliation(clean, summaries).action, 'manual_review', checkpoint);
  }
});

test('verifies callback patches and detects zero-CAS without downstream eligibility', () => {
  const expected = classifyClaim([attempt()], normalized(), HASH, NOW);
  const applied = attempt({
    status: 'completed',
    consumedAtIso: NOW,
    dialogue: 'hello world',
    language: 'en',
    errorCode: '',
    nextRetryAtIso: '',
  });
  const verified = verifyCallbackState([applied], expected);
  assert.equal(verified.action, 'verified');
  assert.equal(verified.triggerPresentation, true);
  assert.equal(verified.triggerCoordinator, true);
  assert.equal(verified.attemptKey, expected.attemptKey);
  assert.equal(verified.requestKey, expected.requestKey);
  assert.equal(verified.logicalJobKey, expected.logicalJobKey);

  for (const field of [
    'id', 'callbackTokenHash', 'attemptKey', 'logicalJobKey', 'requestKey',
    'requestType', 'streamID', 'mode', 'channel', 'threadTS', 'processingMessageTS',
  ]) {
    const drifted = { ...applied, [field]: `${applied[field]}-drift` };
    if (field === 'id') drifted.canonicalRowID = drifted.id;
    assert.throws(
      () => verifyCallbackState([drifted], expected),
      /callback canonical identity mismatch/i,
      field,
    );
  }

  const zeroCas = verifyCallbackState([attempt()], expected);
  assert.equal(zeroCas.action, 'conflict');
  assert.equal(zeroCas.httpStatus, 409);
  assert.equal(zeroCas.triggerPresentation, false);
  assert.equal(zeroCas.triggerCoordinator, false);

  assert.throws(
    () => verifyCallbackState([{ ...applied, dialogue: 'different' }], expected),
    /callback state mismatch/i,
  );
});

test('accepts nonempty and empty completed logical winners with the correct downstream triggers', () => {
  const completedExpected = classifyClaim([attempt()], normalized(), HASH, NOW);
  const completed = attempt({
    status: 'completed', consumedAtIso: NOW, dialogue: 'hello world', language: 'en',
  });
  const completedResult = verifyLogicalWinner(
    [completed],
    verifyCallbackState([completed], completedExpected),
    completedExpected,
  );
  assert.equal(completedResult.action, 'accepted');
  assert.equal(completedResult.httpStatus, 202);
  assert.equal(completedResult.triggerPresentation, true);
  assert.equal(completedResult.triggerCoordinator, true);

  const emptyExpected = classifyClaim(
    [attempt()],
    normalized({ transcription: '' }),
    HASH,
    NOW,
  );
  const emptyCompleted = attempt({
    status: 'completed',
    consumedAtIso: NOW,
    dialogue: '',
    language: '',
    errorCode: 'callback_empty_transcription',
    nextRetryAtIso: '',
    presentationStatus: 'completed',
  });
  const emptyResult = verifyLogicalWinner(
    [emptyCompleted],
    verifyCallbackState([emptyCompleted], emptyExpected),
    emptyExpected,
  );
  assert.equal(emptyResult.action, 'accepted');
  assert.equal(emptyResult.triggerPresentation, false);
  assert.equal(emptyResult.triggerCoordinator, true);
});

test('does not trigger the summary coordinator for standalone STT callbacks', () => {
  const standalone = attempt({
    requestKey: LOGICAL_JOB_KEY,
    requestType: 'standalone_stt',
    status: 'completed',
    consumedAtIso: NOW,
    dialogue: 'hello world',
    language: 'en',
  });
  const expected = classifyClaim(
    [{ ...standalone, status: 'waiting_callback', consumedAtIso: '', dialogue: '', language: '' }],
    normalized({ context: callbackContext({ requestKey: LOGICAL_JOB_KEY, requestType: 'standalone_stt' }) }),
    HASH,
    NOW,
  );
  const result = verifyLogicalWinner(
    [standalone],
    verifyCallbackState([standalone], expected),
    expected,
  );
  assert.equal(result.action, 'accepted');
  assert.equal(result.triggerPresentation, true);
  assert.equal(result.triggerCoordinator, false);
});

test('selects the deterministic completed winner and gives the loser zero downstream triggers', () => {
  const currentExpected = classifyClaim([attempt()], normalized(), HASH, NOW);
  const current = attempt({
    status: 'completed', consumedAtIso: NOW, dialogue: 'hello world', language: 'en',
  });
  const earlier = attempt({
    id: 2,
    attemptKey: `${LOGICAL_JOB_KEY}:2`,
    attempt: 2,
    callbackTokenHash: 'd'.repeat(64),
    canonicalRowID: '2',
    status: 'completed',
    consumedAtIso: '2026-08-22T00:09:00.000Z',
    dialogue: 'earlier',
    language: 'ja',
  });
  const loser = verifyLogicalWinner(
    [current, earlier],
    verifyCallbackState([current], currentExpected),
    currentExpected,
  );
  assert.equal(loser.action, 'duplicate');
  assert.equal(loser.httpStatus, 200);
  assert.equal(loser.triggerPresentation, false);
  assert.equal(loser.triggerCoordinator, false);

  const earlierNormalized = normalized({
    context: callbackContext({ attemptKey: earlier.attemptKey }),
    transcription: 'earlier',
    language: 'ja',
  });
  const earlierExpected = classifyClaim([
    { ...earlier, status: 'waiting_callback', consumedAtIso: '', dialogue: '', language: '' },
  ], earlierNormalized, earlier.callbackTokenHash, earlier.consumedAtIso);
  const winner = verifyLogicalWinner(
    [current, earlier],
    verifyCallbackState([earlier], earlierExpected),
    earlierExpected,
  );
  assert.equal(winner.action, 'accepted');
  assert.equal(winner.triggerPresentation, true);
  assert.equal(winner.triggerCoordinator, true);
});

test('fails closed on post-callback logical-row tampering and multiple canonicals in one attempt', () => {
  const expected = classifyClaim([attempt()], normalized(), HASH, NOW);
  const applied = attempt({
    status: 'completed', consumedAtIso: NOW, dialogue: 'hello world', language: 'en',
  });
  const verified = verifyCallbackState([applied], expected);
  for (const tampered of [
    [{ ...applied, logicalJobKey: `${LOGICAL_JOB_KEY}-other` }],
    [{ ...applied, callbackTokenHash: 'c'.repeat(64) }],
    [{ ...applied, processingMessageTS: 'tampered' }],
    [{ ...applied, dialogue: '' }],
    [applied, { ...applied, id: 2, canonicalRowID: '2' }],
  ]) {
    assert.throws(
      () => verifyLogicalWinner(tampered, verified, expected),
      /logical|post-callback|completed/i,
    );
  }
});

test('fully verifies every frozen competing canonical', () => {
  const expected = [{ id: 1 }, { id: 2 }];
  const frozen = expected.map(({ id }) => attempt({
    id,
    canonicalRowID: String(id),
    status: 'manual_review',
    manualReviewReason: 'multiple_canonical_checkpoint_conflict',
    manualReviewAtIso: NOW,
  }));
  assert.equal(verifyFrozenConflict(frozen, expected).action, 'verified_conflict');
  assert.throws(() => verifyFrozenConflict(frozen.slice(0, 1), expected), /frozen conflict/i);
  assert.throws(
    () => verifyFrozenConflict(frozen.map((row) => ({ ...row, manualReviewAtIso: '' })), expected),
    /frozen conflict state mismatch/i,
  );
  assert.throws(
    () => verifyFrozenConflict(frozen.map((row) => ({ ...row, manualReviewAtIso: '2026-08-22T00:10:00Z' })), expected),
    /frozen conflict state mismatch/i,
  );
});

test('fails closed when re-read Data Tables emit empty placeholders', () => {
  const expected = classifyClaim([attempt()], normalized(), HASH, NOW);
  assert.throws(
    () => verifyFrozenConflict([{}], [{ id: 1 }, { id: 2 }]),
    /frozen conflict/i,
  );
  assert.throws(
    () => planCanonicalReconciliation([{}]),
    /invalid attempt key/i,
  );
  assert.throws(
    () => verifyCallbackState([{}], expected),
    /exactly one canonical row/i,
  );
  assert.throws(
    () => verifyLogicalWinner([{}], { action: 'verified' }, expected),
    /logical job rows not found/i,
  );
});

test('defines an inactive stable POST webhook and explicit response for every logical branch', () => {
  const workflow = readWorkflow();
  const webhook = nodeByName(workflow, 'Stable Callback Webhook');
  const responders = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.respondToWebhook');
  const expectedResponses = new Map([
    ['Respond Malformed', 400],
    ['Respond Invalid Token', 401],
    ['Respond Rejected', 400],
    ['Respond Conflict', 409],
    ['Respond Duplicate', 200],
    ['Respond Accepted', 202],
    ['Respond Internal Error', 500],
  ]);

  assert.equal(workflow.id, 'STTCallbackV3A1');
  assert.equal(workflow.name, 'STT: callback ingress v3');
  assert.equal(workflow.active, false);
  assert.equal(workflow.isArchived, false);
  assert.equal(webhook.parameters.httpMethod, 'POST');
  assert.equal(webhook.parameters.path, 'stt-callback-v3');
  assert.equal(webhook.parameters.responseMode, 'responseNode');
  assert.equal(webhook.webhookId, '6dafbb15-2a2d-4781-9146-76804db72cd0');
  assert.equal(responders.length, expectedResponses.size);
  for (const [name, status] of expectedResponses) {
    const node = nodeByName(workflow, name);
    assert.equal(node.parameters.respondWith, 'json', name);
    assert.equal(node.parameters.options.responseCode, status, name);
    assert.equal(Object.hasOwn(node.parameters, 'responseCode'), false, name);
    assert.deepEqual(node.parameters.options.responseHeaders.entries, [
      { name: 'Content-Type', value: 'application/json' },
    ], name);
  }
});

test('uses native SHA256, all-row hash lookup, same-attempt reread, and cross-table checkpoints', () => {
  const workflow = readWorkflow();
  const hash = nodeByName(workflow, 'Hash Callback Token');
  const tokenRead = nodeByName(workflow, 'Read Rows by Token Hash');
  const attemptRead = nodeByName(workflow, 'Read All Attempt Rows');
  const summaryReads = workflow.nodes.filter(({ name }) => name.includes('Summary') && name.includes('Read'));

  assert.deepEqual(hash.parameters, {
    action: 'hash',
    type: 'SHA256',
    binaryData: false,
    value: '={{ $json.context.callbackToken }}',
    dataPropertyName: 'callbackTokenHash',
    encoding: 'hex',
  });
  assert.equal(tokenRead.parameters.returnAll, true);
  assert.equal(filterMap(tokenRead).callbackTokenHash.keyValue, "={{ $('Hash Callback Token').first().json.callbackTokenHash }}");
  assert.equal(workflow.nodes.some(({ name }) => name === 'Limit Hash Lookup'), false);
  assert.deepEqual(targets(workflow, 'Read Rows by Token Hash'), ['Validate Hash Rows']);
  assert.deepEqual(targets(workflow, 'Validate Hash Rows'), ['Token Hash Found']);
  assert.deepEqual(targets(workflow, 'Validate Hash Rows', 1), ['Respond Internal Error']);
  assert.equal(attemptRead.parameters.returnAll, true);
  assert.equal(filterMap(attemptRead).attemptKey.keyValue, "={{ $('Validate Hash Rows').first().json.attemptKey }}");
  assert.equal(filterMap(nodeByName(workflow, 'Re-read Manual Review State')).attemptKey.keyValue, "={{ $('Validate Hash Rows').first().json.attemptKey }}");
  assert.equal(filterMap(nodeByName(workflow, 'Re-read After Reconciliation')).attemptKey.keyValue, "={{ $('Validate Hash Rows').first().json.attemptKey }}");
  const hashFailureReachable = reachableNodes(workflow, 'Respond Internal Error');
  const updateNames = workflow.nodes
    .filter(({ parameters }) => parameters.operation === 'update')
    .map(({ name }) => name);
  assert.equal(updateNames.some((name) => hashFailureReachable.has(name)), false);
  assert.equal(summaryReads.length, 2);
  assert.ok(summaryReads.every(({ parameters, alwaysOutputData }) => (
    parameters.dataTableId.value === 'summary_requests_v3' &&
    parameters.operation === 'get' && parameters.returnAll === true && alwaysOutputData === true
  )));
});

test('uses exact soft-CAS result filters, Limit, reread, and zero-CAS verifier', () => {
  const workflow = readWorkflow();
  const claims = [
    ['Consume Waiting Callback', 'waiting_callback', false],
    ['Consume Retry Pending', 'retry_pending', false],
    ['Consume Manual Review', 'manual_review', true],
  ];
  for (const [name, status, manual] of claims) {
    const node = nodeByName(workflow, name);
    const filters = filterMap(node);
    assert.equal(node.parameters.matchType, 'allConditions', name);
    assert.equal(filters.id.keyValue, '={{ $json.id }}', name);
    assert.equal(filters.attemptKey.keyValue, '={{ $json.attemptKey }}', name);
    assert.equal(filters.reconciliationStatus.keyValue, 'canonical', name);
    assert.equal(filters.canonicalRowID.keyValue, '={{ String($json.id) }}', name);
    assert.equal(filters.status.keyValue, status, name);
    assert.equal(filters.consumedAtIso.keyValue, '', name);
    assert.equal(filters.callbackTokenHash.keyValue, '={{ $json.callbackTokenHash }}', name);
    assert.equal(Boolean(filters.manualReviewResolution), manual, name);
    assert.equal(node.parameters.columns.value.consumedAtIso, '={{ $json.consumedAtIso }}', name);
    assert.equal(node.parameters.columns.value.presentationStatus, '={{ $json.desiredPresentationStatus }}', name);
    assert.equal(node.alwaysOutputData, true, name);
    assert.deepEqual(targets(workflow, name), [`Limit ${name}`]);
    assert.deepEqual(targets(workflow, `Limit ${name}`), ['Re-read Callback Result']);
  }
  assert.deepEqual(targets(workflow, 'Re-read Callback Result'), ['Verify Callback Result']);
  assert.deepEqual(targets(workflow, 'Verify Callback Result'), ['Is Verified Result']);
  assert.deepEqual(targets(workflow, 'Is Verified Result'), ['Read Post-Callback Logical Job Rows']);
  assert.deepEqual(targets(workflow, 'Read Post-Callback Logical Job Rows'), ['Verify Logical Winner']);
  assert.deepEqual(targets(workflow, 'Read Post-Callback Logical Job Rows', 1), ['Respond Internal Error']);
  assert.deepEqual(targets(workflow, 'Verify Logical Winner'), ['Is Logical Winner Accepted']);
  assert.deepEqual(targets(workflow, 'Verify Logical Winner', 1), ['Respond Internal Error']);
  assert.deepEqual(targets(workflow, 'Is Logical Winner Accepted'), ['Respond Accepted']);
  assert.deepEqual(targets(workflow, 'Is Logical Winner Accepted', 1), ['Is Logical Winner Duplicate']);
  assert.deepEqual(targets(workflow, 'Is Logical Winner Duplicate'), ['Respond Duplicate']);
  assert.deepEqual(targets(workflow, 'Is Logical Winner Duplicate', 1), ['Respond Internal Error']);
  assert.deepEqual(targets(workflow, 'Is Verified Result', 1), ['Respond Conflict']);
});

test('keeps every critical re-read alive on zero rows and routes failures to sanitized 500', () => {
  const workflow = readWorkflow();
  const rereads = [
    ['Re-read Manual Review State', 'Verify Frozen Conflict'],
    ['Re-read After Reconciliation', 'Verify Reconciled Canonical'],
    ['Re-read Callback Result', 'Verify Callback Result'],
    ['Read Post-Callback Logical Job Rows', 'Verify Logical Winner'],
  ];
  for (const [name, verifier] of rereads) {
    const node = nodeByName(workflow, name);
    assert.equal(node.parameters.operation, 'get', name);
    assert.equal(node.parameters.returnAll, true, name);
    assert.equal(node.alwaysOutputData, true, name);
    assert.equal(node.onError, 'continueErrorOutput', name);
    assert.deepEqual(targets(workflow, name, 1), ['Respond Internal Error'], name);
    assert.equal(reachableNodes(workflow, name).has(verifier), true, name);
    assert.deepEqual(targets(workflow, verifier, 1), ['Respond Internal Error'], verifier);
  }
});

test('routes pre- and post-consumption provenance verifier errors to sanitized 500', () => {
  const workflow = readWorkflow();
  assert.deepEqual(targets(workflow, 'Classify Claim', 1), ['Respond Internal Error']);
  assert.deepEqual(targets(workflow, 'Verify Logical Winner', 1), ['Respond Internal Error']);
  assert.equal(reachableNodes(workflow, 'Respond Internal Error').has('Respond Duplicate'), false);
});

test('freezes checkpoint conflicts completely and clean reconciliation reaches exactly one canonical', () => {
  const workflow = readWorkflow();
  const freeze = nodeByName(workflow, 'Freeze Canonical Conflict');
  const freezeFilters = filterMap(freeze);
  assert.equal(freezeFilters.id.keyValue, '={{ $json.id }}');
  assert.equal(freezeFilters.attemptKey.keyValue, '={{ $json.attemptKey }}');
  assert.equal(freezeFilters.status.keyValue, '={{ $json.expectedStatus }}');
  assert.equal(freezeFilters.reconciliationStatus.keyValue, 'canonical');
  assert.equal(freezeFilters.canonicalRowID.keyValue, '={{ String($json.id) }}');
  assert.equal(freeze.alwaysOutputData, true);
  assert.deepEqual(targets(workflow, 'Freeze Canonical Conflict'), ['Limit Conflict Patch']);
  assert.deepEqual(targets(workflow, 'Limit Conflict Patch'), ['Re-read Manual Review State']);
  assert.deepEqual(targets(workflow, 'Re-read Manual Review State'), ['Verify Frozen Conflict']);
  assert.deepEqual(targets(workflow, 'Verify Frozen Conflict'), ['Respond Conflict']);
  const conflictReachable = reachableNodes(workflow, 'Verify Frozen Conflict');
  assert.equal(conflictReachable.has('Consume Waiting Callback'), false);
  assert.equal(conflictReachable.has('Run Presentation Owner'), false);

  assert.deepEqual(targets(workflow, 'Apply Reconciliation'), ['Limit Reconciliation Writes']);
  assert.deepEqual(targets(workflow, 'Limit Reconciliation Writes'), ['Re-read After Reconciliation']);
  assert.deepEqual(targets(workflow, 'Re-read After Reconciliation'), ['Limit Reconciled Context']);
  assert.deepEqual(targets(workflow, 'Limit Reconciled Context'), ['Read Summary Rows After Reconciliation']);
  assert.deepEqual(targets(workflow, 'Read Summary Rows After Reconciliation'), ['Verify Reconciled Canonical']);
});

test('triggers presentation and coordinator only after verified accepted state', () => {
  const workflow = readWorkflow();
  const presentation = nodeByName(workflow, 'Run Presentation Owner');
  const coordinator = nodeByName(workflow, 'Run Summary Coordinator');
  assert.deepEqual(presentation.parameters.workflowId, {
    __rl: true,
    value: 'STTListenerV3A01',
    mode: 'list',
    cachedResultUrl: '/workflow/STTListenerV3A01',
    cachedResultName: 'STT result listener v3',
  });
  assert.deepEqual(coordinator.parameters.workflowId, {
    __rl: true,
    value: 'SummaryCoordV3A1',
    mode: 'list',
    cachedResultUrl: '/workflow/SummaryCoordV3A1',
    cachedResultName: 'Summary: coordinator v3',
  });
  assert.equal(presentation.parameters.options.waitForSubWorkflow, false);
  assert.equal(coordinator.parameters.options.waitForSubWorkflow, false);
  assert.equal(presentation.parameters.workflowInputs.value.attemptKey, '={{ $json.attemptKey }}');
  assert.equal(coordinator.parameters.workflowInputs.value.requestKey, '={{ $json.requestKey }}');
  assert.deepEqual(targets(workflow, 'Is Verified Result', 0), ['Read Post-Callback Logical Job Rows']);
  assert.equal(reachableNodes(workflow, 'Verify Callback Result').has('Read Post-Callback Logical Job Rows'), true);
  assert.equal(reachableNodes(workflow, 'Read Post-Callback Logical Job Rows').has('Respond Accepted'), true);
  assert.equal(reachableNodes(workflow, 'Read Post-Callback Logical Job Rows').has('Respond Duplicate'), true);
  assert.equal(reachableNodes(workflow, 'Read Post-Callback Logical Job Rows').has('Respond Internal Error'), true);
  assert.ok(targets(workflow, 'Respond Accepted').includes('Accepted Result Type'));
  const acceptedResultCondition = nodeByName(workflow, 'Accepted Result Type').parameters.conditions.conditions[0];
  assert.equal(acceptedResultCondition.leftValue, '={{ $json.triggerPresentation }}');
  assert.deepEqual(acceptedResultCondition.operator, {
    type: 'boolean',
    operation: 'true',
    singleValue: true,
  });
  assert.deepEqual(targets(workflow, 'Accepted Result Type', 0), ['Run Presentation Owner']);
  assert.deepEqual(targets(workflow, 'Accepted Result Type', 1), ['Run Summary Coordinator']);
  assert.ok(targets(workflow, 'Run Presentation Owner').includes('Run Summary Coordinator'));
  assert.equal(reachableNodes(workflow, 'Respond Duplicate').has('Run Presentation Owner'), false);
  assert.equal(reachableNodes(workflow, 'Respond Duplicate').has('Run Summary Coordinator'), false);
  assert.equal(reachableNodes(workflow, 'Respond Conflict').has('Run Summary Coordinator'), false);
});

test('keeps exact source Data Table names and proves P4 remaps each node to its P3 ID', () => {
  const workflow = readWorkflow();
  const tableNodes = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.dataTable');
  assert.ok(tableNodes.length > 0);
  assert.equal(collectDataTableReferences([workflow]).length, tableNodes.length);
  for (const node of tableNodes) {
    assert.equal(node.typeVersion, 1, node.name);
    assert.deepEqual(node.parameters.dataTableId, {
      __rl: true,
      mode: 'name',
      value: node.parameters.dataTableId.value,
    }, node.name);
    assert.ok(P3_IDS.has(node.parameters.dataTableId.value), node.name);
  }
  const remapped = remapDataTableReferences(workflow.nodes, P3_IDS);
  for (const node of remapped.filter(({ type }) => type === 'n8n-nodes-base.dataTable')) {
    const source = nodeByName(workflow, node.name);
    assert.deepEqual(node.parameters.dataTableId, {
      __rl: true,
      mode: 'id',
      value: P3_IDS.get(source.parameters.dataTableId.value),
    }, node.name);
  }
});

test('writes only masked primitive audit fields after responses and does not retain execution payloads', () => {
  const workflow = readWorkflow();
  const audit = nodeByName(workflow, 'Write Masked Audit');
  const auditValues = audit.parameters.columns.value;
  const allowed = new Set([
    'errorKey', 'component', 'reconciliationStatus', 'canonicalRowID', 'requestKey',
    'logicalJobKey', 'attemptKey', 'executionID', 'workflowName', 'nodeName',
    'errorCode', 'messageMasked', 'retryable', 'createdAtIso',
  ]);
  assert.ok(Object.keys(auditValues).every((key) => allowed.has(key)));
  assert.equal(audit.parameters.dataTableId.value, 'automation_errors_v3');
  assert.equal(audit.parameters.operation, 'insert');
  assert.equal(audit.onError, 'continueRegularOutput');
  assert.match(auditValues.errorCode, /Respond Invalid Token/);
  assert.match(auditValues.errorCode, /invalid_token/);
  const auditText = JSON.stringify(audit);
  assert.doesNotMatch(auditText, /callbackTokenHash|callbackToken|headers|\$json\.body|responseBody/i);
  for (const responder of workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.respondToWebhook')) {
    assert.ok(targets(workflow, responder.name).includes('Write Masked Audit'), responder.name);
  }
  assert.deepEqual(workflow.settings, {
    executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all',
    saveManualExecutions: true, saveExecutionProgress: false,
  });
});

test('wires every pre-response fallible node error output to the sanitized 500 response', () => {
  const workflow = readWorkflow();
  const fallibleTypes = new Set([
    'n8n-nodes-base.code',
    'n8n-nodes-base.crypto',
    'n8n-nodes-base.dataTable',
  ]);
  for (const node of workflow.nodes.filter(({ type, name }) => (
    fallibleTypes.has(type) && name !== 'Write Masked Audit'
  ))) {
    assert.equal(node.onError, 'continueErrorOutput', node.name);
    assert.deepEqual(targets(workflow, node.name, 1), ['Respond Internal Error'], node.name);
  }
});

test('uses UUIDv4 node IDs and contains no token in URL, logs, responses, audit, or resume URL', () => {
  const workflow = readWorkflow();
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.ok(workflow.nodes.every(({ id }) => uuidV4.test(id)));
  assert.equal(new Set(workflow.nodes.map(({ id }) => id)).size, workflow.nodes.length);
  assert.equal(new Set(workflow.nodes.map(({ name }) => name)).size, workflow.nodes.length);
  const responseText = JSON.stringify(workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.respondToWebhook'));
  assert.doesNotMatch(responseText, /callbackToken|callbackTokenHash|\$json\.body/i);
  const urls = workflow.nodes.flatMap(({ parameters }) => parameters.url ? [parameters.url] : []);
  assert.ok(urls.every((url) => !/token|hash/i.test(url)));
  const code = [normalizePath, validateHashPath, classifyPath, reconcilePath, verifyPath, verifyLogicalPath]
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(code, /console\.(?:log|debug|info|warn|error)/);
  assert.doesNotMatch(code, /\$execution\.resumeUrl|resumeUrl/);
  assert.doesNotMatch(code, /require\s*\(\s*['"](?:node:)?crypto['"]\s*\)/);
});
