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
const payloadCodePath = path.join(workflowDir, 'nodes', 'Build_VDS_Payload', 'jsCode.js');
const ackCodePath = path.join(workflowDir, 'nodes', 'Classify_ACK', 'jsCode.js');
const reconciliationCodePath = path.join(workflowDir, 'nodes', 'Reconcile_Canonical', 'jsCode.js');
const ownerCodePath = path.join(workflowDir, 'nodes', 'Require_Canonical_Owner', 'jsCode.js');
const stateVerifierCodePath = path.join(workflowDir, 'nodes', 'Verify_Final_State', 'jsCode.js');

const {
  buildVdsPayload,
  callbackDeadline,
  dispatchLeaseExpiry,
  strictFiniteNumber,
  tokenExpiry,
} = require(payloadCodePath);
const {
  MAX_AUTOMATIC_ATTEMPTS,
  RETRY_DEADLINE_MINUTES,
  RETRY_SLOT_MINUTES,
  SUMMARY_RETRY_DEADLINE_MINUTES,
  SUMMARY_RETRY_SLOT_MINUTES,
  SINGLE_STREAM_CALLBACK_DEADLINE_MINUTES,
  classifyAck: classifyAckPolicy,
} = require(ackCodePath);
const {
  ATTEMPT_CHECKPOINT_FIELDS,
  SUMMARY_CHECKPOINT_FIELDS,
  planCanonicalReconciliation,
} = require(reconciliationCodePath);
const { requireCanonicalOwner } = require(ownerCodePath);

const CALLBACK_URL = 'https://n8n.example/webhook/stt-callback-v3';
const NOW = '2026-08-22T00:00:00.000Z';
const TOKEN = 'a'.repeat(64);
const PAYLOAD_KEYS = [
  'userID', 'openID', 'streamID', 'region', 'sttModel', 'language',
  'createdTime', 'endTime', 'duration', 'scheduledAt', 'contractType',
  'vliverModel', 'appVersion', 'deviceType', 'streamSegment', 'webhookConfiguration',
];
const CONTEXT_KEYS = [
  'attemptKey', 'logicalJobKey', 'requestKey', 'requestType', 'streamID',
  'mode', 'channel', 'threadTS', 'processingMessageTS', 'callbackToken',
];
const EXPECTED_ATTEMPT_CHECKPOINT_FIELDS = [
  'submittedAtIso', 'callbackDeadlineAtIso', 'consumedAtIso', 'dialogue',
  'transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso',
];
const EXPECTED_SUMMARY_CHECKPOINT_FIELDS = [
  'inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS',
];
const P3_ARTIFACT = Object.freeze({
  tables: Object.freeze([
    Object.freeze({ name: 'suspect_stt_candidates_v3', id: 'p3-suspects' }),
    Object.freeze({ name: 'stt_jobs_v3', id: 'p3-jobs' }),
    Object.freeze({ name: 'summary_requests_v3', id: 'p3-summaries' }),
    Object.freeze({ name: 'automation_errors_v3', id: 'p3-errors' }),
  ]),
});
const P3_DATA_TABLE_IDS = new Map(P3_ARTIFACT.tables.map(({ name, id }) => [name, id]));

function attempt(overrides = {}) {
  return {
    id: 1,
    createdAt: NOW,
    updatedAt: NOW,
    attemptKey: 'summary:req-001:current:9001:fromStart:1',
    logicalJobKey: 'summary:req-001:current:9001:fromStart',
    requestKey: 'summary:req-001',
    requestType: 'suspect',
    attempt: 1,
    streamID: '9001',
    mode: 'fromStart',
    durationMinutes: 5,
    streamContextJson: JSON.stringify({
      userID: 'user-1',
      openID: 'open-1',
      region: 'TW',
      beginTime: 1787360400,
      endTime: 1787364000,
      duration: 3600,
      vliverModel: 0,
      appVersion: '3.4.5',
      deviceType: 'ios',
    }),
    status: 'queued',
    reconciliationStatus: 'canonical',
    canonicalRowID: '1',
    channel: 'C0A4JJJKJMD',
    threadTS: '1787364000.000001',
    processingMessageTS: '1787364001.000002',
    ...overrides,
  };
}

function standaloneAttempt(overrides = {}) {
  const logicalJobKey = 'stt:1787364000.000001:1787364001.000002:9001:fromStart';
  return attempt({
    attemptKey: `${logicalJobKey}:1`,
    logicalJobKey,
    requestKey: logicalJobKey,
    requestType: 'standalone_stt',
    ...overrides,
  });
}

function summaryRequest(overrides = {}) {
  return {
    id: 'summary-row-a',
    createdAt: NOW,
    requestKey: 'summary:req-001',
    requestType: 'standalone_stt',
    status: 'ready',
    reconciliationStatus: 'canonical',
    canonicalRowID: 'summary-row-a',
    ...overrides,
  };
}

function classifyAck(outcome, candidate, nowIso = NOW, requestRows) {
  const rows = requestRows ?? (candidate.requestType === 'standalone_stt' ? [{}] : [summaryRequest()]);
  return classifyAckPolicy(outcome, candidate, rows, nowIso);
}

function readWorkflow() {
  return JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
}

function loadStateVerifier() {
  return require(stateVerifierCodePath);
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

test('builds the complete canonical VDS payload field-for-field with exact types', () => {
  const payload = buildVdsPayload(attempt(), TOKEN, CALLBACK_URL, Date.parse(NOW));

  assert.deepEqual(payload, {
    userID: 'user-1',
    openID: 'open-1',
    streamID: '9001',
    region: 'TW',
    sttModel: 'whisper-large-v3',
    language: '',
    createdTime: 1787360400,
    endTime: 1787364000,
    duration: 3600,
    scheduledAt: 1787356800000,
    contractType: 1,
    vliverModel: 0,
    appVersion: '3.4.5',
    deviceType: 'ios',
    streamSegment: { mode: 'fromStart', durationMinutes: 5 },
    webhookConfiguration: {
      url: CALLBACK_URL,
      context: {
        attemptKey: 'summary:req-001:current:9001:fromStart:1',
        logicalJobKey: 'summary:req-001:current:9001:fromStart',
        requestKey: 'summary:req-001',
        requestType: 'suspect',
        streamID: '9001',
        mode: 'fromStart',
        channel: 'C0A4JJJKJMD',
        threadTS: '1787364000.000001',
        processingMessageTS: '1787364001.000002',
        callbackToken: TOKEN,
      },
    },
  });
  assert.deepEqual(Object.keys(payload), PAYLOAD_KEYS);
  assert.deepEqual(Object.keys(payload.webhookConfiguration.context), CONTEXT_KEYS);
  assert.equal(typeof payload.createdTime, 'number');
  assert.equal(typeof payload.endTime, 'number');
  assert.equal(typeof payload.duration, 'number');
  assert.equal(typeof payload.scheduledAt, 'number');
  assert.equal(typeof payload.contractType, 'number');
  assert.equal(typeof payload.vliverModel, 'number');
  assert.equal(typeof payload.streamSegment.durationMinutes, 'number');
});

test('accepts only finite numbers and trimmed plain-decimal numeric strings', () => {
  for (const [value, expected] of [
    [0, 0],
    [-0.5, -0.5],
    ['0', 0],
    [' 12.5 ', 12.5],
    ['.25', 0.25],
    ['+7', 7],
    ['-3.5', -3.5],
  ]) {
    assert.equal(strictFiniteNumber(value, 'fixture'), expected);
  }

  for (const value of [
    null, undefined, true, false, '', '   ', Number.NaN, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY, [], {}, 'NaN', 'Infinity', '-Infinity', '0x10', '1e3',
    '1.', '+', '-', '. ',
  ]) {
    assert.throws(() => strictFiniteNumber(value, 'fixture'), /invalid canonical fixture/i, String(value));
  }
});

test('rejects malformed values in every VDS numeric field without coercing zero', () => {
  const malformed = [null, undefined, true, false, '', '   ', [], {}, '0x10', '1e3'];
  const contextFields = ['beginTime', 'endTime', 'duration', 'vliverModel'];

  for (const field of contextFields) {
    for (const value of malformed) {
      const streamContext = JSON.parse(attempt().streamContextJson);
      streamContext[field] = value;
      const candidate = attempt({ streamContextJson: JSON.stringify(streamContext) });
      assert.throws(() => buildVdsPayload(candidate, TOKEN, CALLBACK_URL), /invalid canonical/i, `${field}: ${String(value)}`);
    }
  }
  for (const value of [...malformed, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => buildVdsPayload(attempt({ durationMinutes: value }), TOKEN, CALLBACK_URL),
      /invalid canonical durationMinutes/i,
      `durationMinutes: ${String(value)}`,
    );
  }
});

test('enforces VDS numeric boundaries and preserves valid decimal-string payload types', () => {
  const streamContext = JSON.parse(attempt().streamContextJson);
  Object.assign(streamContext, {
    beginTime: ' 1 ',
    endTime: '2.5',
    duration: '0',
    vliverModel: '0.0',
  });
  const payload = buildVdsPayload(attempt({
    streamContextJson: JSON.stringify(streamContext),
    durationMinutes: ' .5 ',
  }), TOKEN, CALLBACK_URL);
  assert.equal(payload.createdTime, 1);
  assert.equal(payload.endTime, 2.5);
  assert.equal(payload.duration, 0);
  assert.equal(payload.vliverModel, 0);
  assert.equal(payload.streamSegment.durationMinutes, 0.5);

  const invalidCases = [
    ['createdTime zero', { beginTime: 0 }],
    ['endTime zero', { endTime: 0 }],
    ['endTime equal', { beginTime: 10, endTime: 10 }],
    ['endTime before createdTime', { beginTime: 11, endTime: 10 }],
    ['negative duration', { duration: -0.1 }],
    ['negative vliverModel', { vliverModel: -1 }],
  ];
  for (const [label, overrides] of invalidCases) {
    const invalidContext = JSON.parse(attempt().streamContextJson);
    Object.assign(invalidContext, overrides);
    assert.throws(
      () => buildVdsPayload(attempt({ streamContextJson: JSON.stringify(invalidContext) }), TOKEN, CALLBACK_URL),
      /invalid canonical|endTime must be greater/i,
      label,
    );
  }
  for (const durationMinutes of [0, -0.1, '0', '-1']) {
    assert.throws(
      () => buildVdsPayload(attempt({ durationMinutes }), TOKEN, CALLBACK_URL),
      /invalid canonical durationMinutes/i,
    );
  }
});

test('accepts only the canonical mode, allowlisted channels, and fixed HTTPS callback path', () => {
  assert.throws(() => buildVdsPayload(attempt({ mode: 'first' }), TOKEN, CALLBACK_URL), /canonical mode/i);
  assert.equal(buildVdsPayload(attempt({ channel: 'C09F0SYG57D' }), TOKEN, CALLBACK_URL).webhookConfiguration.context.channel, 'C09F0SYG57D');
  assert.throws(() => buildVdsPayload(attempt({ channel: 'C0OTHER' }), TOKEN, CALLBACK_URL), /channel/i);
  assert.throws(() => buildVdsPayload(attempt(), TOKEN, 'http://n8n.example/webhook/stt-callback-v3'), /https/i);
  assert.throws(() => buildVdsPayload(attempt(), TOKEN, 'https://n8n.example/webhook/other'), /callback path/i);
  assert.throws(() => buildVdsPayload(attempt(), TOKEN, `${CALLBACK_URL}?token=x`), /callback path/i);
  assert.throws(() => buildVdsPayload(attempt(), 'short', CALLBACK_URL), /token/i);
});

test('validates the fixed callback URL without the sandbox URL constructor', () => {
  const originalURL = global.URL;
  try {
    global.URL = undefined;
    assert.equal(buildVdsPayload(attempt(), TOKEN, CALLBACK_URL).webhookConfiguration.url, CALLBACK_URL);
  } finally {
    global.URL = originalURL;
  }
});

test('keeps token only in callback body context and computes fixed time boundaries', () => {
  const payload = buildVdsPayload(attempt(), TOKEN, CALLBACK_URL, Date.parse(NOW));

  assert.equal(payload.webhookConfiguration.url, CALLBACK_URL);
  assert.equal(payload.webhookConfiguration.context.callbackToken, TOKEN);
  assert.doesNotMatch(payload.webhookConfiguration.url, /token|hash/i);
  assert.equal(tokenExpiry(NOW), '2026-08-23T00:00:00.000Z');
  assert.equal(dispatchLeaseExpiry(NOW), '2026-08-23T00:00:00.000Z');
  assert.equal(callbackDeadline('2026-08-22T00:00:10.000Z'), '2026-08-23T00:00:10.000Z');
});

test('classifies accepted HTTP responses and all absolute retry slots', () => {
  assert.equal(MAX_AUTOMATIC_ATTEMPTS, 20);
  assert.equal(RETRY_DEADLINE_MINUTES, 720);
  assert.deepEqual(RETRY_SLOT_MINUTES, [1, 2, 4, 6, 9, 13, 18, 25, 35, 48, 65, 88, 118, 158, 211, 281, 374, 497, 660]);
  for (const statusCode of [200, 201, 202, 204, 299]) {
    const result = classifyAck({ statusCode }, standaloneAttempt({ attempt: 1 }), NOW);
    assert.equal(result.classification, 'accepted');
    assert.equal(result.status, 'waiting_callback');
    assert.equal(result.submittedAtIso, NOW);
    assert.equal(result.callbackDeadlineAtIso, '2026-08-22T00:01:00.000Z');
  }

  for (const statusCode of [400, 401, 404, 422, 499]) {
    assert.deepEqual(classifyAck({ statusCode }, standaloneAttempt({ attempt: 1 }), NOW), {
      classification: 'terminal_http_failure',
      status: 'failed',
      errorCode: `vds_http_${statusCode}`,
      nextRetryAtIso: '',
    });
  }

  for (const statusCode of [429, 500, 502, 503, 504]) {
    RETRY_SLOT_MINUTES.forEach((minutes, index) => {
      const result = classifyAck({ statusCode }, standaloneAttempt({ attempt: index + 1 }), NOW);
      assert.equal(result.status, 'retry_pending');
      assert.equal(result.nextRetryAtIso, new Date(Date.parse(NOW) + minutes * 60_000).toISOString());
    });
    assert.equal(classifyAck({ statusCode }, standaloneAttempt({ attempt: 20 }), NOW).status, 'failed');
    assert.equal(classifyAck({ statusCode }, standaloneAttempt({ attempt: 20 }), NOW).nextRetryAtIso, '');
  }

  assert.equal(classifyAck({ statusCode: 202 }, standaloneAttempt({ attempt: 20 }), NOW).callbackDeadlineAtIso, '2026-08-22T12:00:00.000Z');
  assert.equal(classifyAck({ statusCode: 202 }, standaloneAttempt({ attempt: 21 }), NOW).callbackDeadlineAtIso, '2026-08-23T00:00:00.000Z');
  assert.equal(classifyAck({ statusCode: 503 }, standaloneAttempt({ attempt: 21 }), NOW).status, 'failed');
});

test('classifies standalone ACKs without a summary request row', () => {
  const result = classifyAckPolicy({ statusCode: 200 }, standaloneAttempt(), [{}], NOW);
  assert.equal(result.classification, 'accepted');
  assert.equal(result.status, 'waiting_callback');
  assert.equal(result.submittedAtIso, NOW);
  assert.throws(
    () => classifyAckPolicy({ statusCode: 200 }, standaloneAttempt({ requestKey: 'other' }), [{}], NOW),
    /standalone request linkage/i,
  );
});

test('caps summary-triggered STT retries at thirty minutes without changing standalone STT', () => {
  assert.equal(SUMMARY_RETRY_DEADLINE_MINUTES, 30);
  assert.deepEqual(SUMMARY_RETRY_SLOT_MINUTES, [1, 2, 4, 6, 9, 13, 18, 25]);
  const requestRows = [summaryRequest({ requestType: 'suspect_summary' })];
  SUMMARY_RETRY_SLOT_MINUTES.forEach((minutes, index) => {
    const result = classifyAck({ statusCode: 503 }, attempt({ attempt: index + 1 }), NOW, requestRows);
    assert.equal(result.status, 'retry_pending');
    assert.equal(result.nextRetryAtIso, new Date(Date.parse(NOW) + minutes * 60_000).toISOString());
  });
  assert.equal(classifyAck({ statusCode: 202 }, attempt({ attempt: 9 }), NOW, requestRows).callbackDeadlineAtIso, '2026-08-22T00:30:00.000Z');
  assert.equal(classifyAck({ statusCode: 503 }, attempt({ attempt: 9 }), NOW, requestRows).status, 'failed');
});

test('keeps full-stream callbacks pending for 150 minutes while submission retries stay bounded', () => {
  assert.equal(SINGLE_STREAM_CALLBACK_DEADLINE_MINUTES, 150);
  const requestRows = [summaryRequest({ requestType: 'single_stream_summary' })];
  const accepted = classifyAck({ statusCode: 202 }, attempt({
    requestType: 'single_stream_summary',
    durationMinutes: 130,
  }), NOW, requestRows);

  assert.equal(accepted.status, 'waiting_callback');
  assert.equal(accepted.callbackDeadlineAtIso, '2026-08-22T02:30:00.000Z');
  assert.equal(Date.parse(accepted.callbackDeadlineAtIso) > Date.parse('2026-08-22T02:10:00.000Z'), true);

  const retry = classifyAck({ statusCode: 503 }, attempt({ requestType: 'single_stream_summary' }), NOW, requestRows);
  assert.equal(retry.status, 'retry_pending');
  assert.equal(retry.nextRetryAtIso, '2026-08-22T00:01:00.000Z');
});

test('routes every transport error to manual review without automatic retry', () => {
  for (const attemptNumber of [1, 20, 21]) {
    assert.deepEqual(classifyAck({ transportError: true }, standaloneAttempt({ attempt: attemptNumber }), NOW), {
      classification: 'ambiguous_transport',
      status: 'manual_review',
      manualReviewReason: 'vds_submit_outcome_ambiguous',
      manualReviewAtIso: NOW,
      nextRetryAtIso: '',
    });
  }
});

test('preserves an existing canonical and elects system earliest only when absent', () => {
  const existing = attempt({ id: 26, canonicalRowID: '26' });
  const later = attempt({
    id: 1,
    createdAt: '2026-08-22T00:01:00.000Z',
    reconciliationStatus: 'pending',
    canonicalRowID: '',
  });
  const existingPlan = planCanonicalReconciliation([existing, later]);

  assert.equal(existingPlan.action, 'reconcile');
  assert.equal(existingPlan.winnerRowID, 26);
  assert.deepEqual(existingPlan.mutations.map(({ id, desiredReconciliationStatus, desiredCanonicalRowID }) => ({
    id, desiredReconciliationStatus, desiredCanonicalRowID,
  })), [{ id: 1, desiredReconciliationStatus: 'duplicate', desiredCanonicalRowID: '26' }]);

  const noCanonicalPlan = planCanonicalReconciliation([
    attempt({ id: 2, reconciliationStatus: 'pending', canonicalRowID: '' }),
    attempt({ id: 1, reconciliationStatus: 'pending', canonicalRowID: '' }),
  ]);
  assert.equal(noCanonicalPlan.winnerRowID, 1);
  assert.equal(noCanonicalPlan.mutations.find(({ id }) => id === 1).desiredReconciliationStatus, 'canonical');
  assert.ok(noCanonicalPlan.mutations.filter(({ id }) => id !== 1).every(({ desiredReconciliationStatus }) => desiredReconciliationStatus === 'duplicate'));
});

test('accepts Production numeric system ids while retaining string canonical references', () => {
  const canonical = attempt({ id: 2, canonicalRowID: '2' });
  const duplicate = attempt({
    id: 3,
    reconciliationStatus: 'duplicate',
    canonicalRowID: '2',
  });
  const plan = planCanonicalReconciliation([canonical, duplicate]);

  assert.equal(plan.winnerRowID, 2);
  assert.equal(typeof plan.winnerRowID, 'number');
  assert.equal(plan.mutations.length, 0);

  const elected = planCanonicalReconciliation([
    attempt({ id: 3, reconciliationStatus: 'pending', canonicalRowID: '' }),
    attempt({ id: 2, reconciliationStatus: 'pending', canonicalRowID: '' }),
  ]);
  assert.equal(elected.winnerRowID, 2);
  assert.ok(elected.mutations.every(({ desiredCanonicalRowID }) => desiredCanonicalRowID === '2'));

  for (const id of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    assert.throws(
      () => planCanonicalReconciliation([attempt({ id, canonicalRowID: String(id) })]),
      /required system field|invalid reconciliation/i,
      String(id),
    );
  }
});

test('demotes only clean canonical losers and freezes checkpoint conflicts', () => {
  const cleanRows = [
    attempt({ id: 2, canonicalRowID: '2' }),
    attempt({ id: 1, canonicalRowID: '1' }),
  ];
  const cleanPlan = planCanonicalReconciliation(cleanRows);
  assert.equal(cleanPlan.action, 'reconcile');
  assert.equal(cleanPlan.winnerRowID, 1);
  assert.deepEqual(cleanPlan.mutations.map(({ id }) => id), [2]);
  assert.equal(cleanPlan.mutations[0].expectedReconciliationStatus, 'canonical');
  assert.equal(cleanPlan.mutations[0].expectedCanonicalRowID, '2');

  assert.deepEqual(ATTEMPT_CHECKPOINT_FIELDS, EXPECTED_ATTEMPT_CHECKPOINT_FIELDS);
  assert.deepEqual(SUMMARY_CHECKPOINT_FIELDS, EXPECTED_SUMMARY_CHECKPOINT_FIELDS);

  for (const checkpoint of EXPECTED_ATTEMPT_CHECKPOINT_FIELDS) {
    const rows = cleanRows.map((row) => ({ ...row }));
    rows[1][checkpoint] = `${checkpoint}-value`;
    const plan = planCanonicalReconciliation(rows, []);
    assert.equal(plan.action, 'manual_review', checkpoint);
    assert.equal(plan.reason, 'multiple_canonical_checkpoint_conflict');
    assert.equal(plan.mutations.length, 2);
    assert.ok(plan.mutations.every((mutation) => mutation.desiredStatus === 'manual_review'));
  }
});

test('freezes multiple canonicals when any noncanonical same-attempt row has an attempt checkpoint', () => {
  const rows = [
    attempt({ id: 2, canonicalRowID: '2' }),
    attempt({ id: 1, canonicalRowID: '1' }),
    attempt({
      id: 4,
      reconciliationStatus: 'pending',
      canonicalRowID: '',
      submittedAtIso: '2026-08-22T00:00:01.000Z',
    }),
  ];

  assert.equal(planCanonicalReconciliation(rows, []).action, 'manual_review');
});

test('reads Summary checkpoints only from matching summary request rows', () => {
  const rows = [
    attempt({ id: 2, canonicalRowID: '2' }),
    attempt({ id: 1, canonicalRowID: '1' }),
  ];

  for (const checkpoint of EXPECTED_SUMMARY_CHECKPOINT_FIELDS) {
    const summaries = [summaryRequest({ [checkpoint]: `${checkpoint}-value` })];
    assert.equal(planCanonicalReconciliation(rows, summaries).action, 'manual_review', checkpoint);
  }

  assert.equal(planCanonicalReconciliation(rows, []).action, 'reconcile');
  assert.equal(planCanonicalReconciliation(rows, [{}]).action, 'reconcile');
  assert.throws(
    () => planCanonicalReconciliation(rows, [summaryRequest({ requestKey: 'summary:req-other' })]),
    /summary request key mismatch/i,
  );
});

test('fails closed before multiple-canonical decisions when attempt request keys differ', () => {
  const rows = [
    attempt({ id: 2, canonicalRowID: '2' }),
    attempt({ id: 1, canonicalRowID: '1', requestKey: 'summary:req-other' }),
  ];

  assert.throws(() => planCanonicalReconciliation(rows, []), /attempt request key mismatch/i);
});

test('fails closed before single-canonical duplicate reconciliation when request keys differ', () => {
  const rows = [
    attempt(),
    attempt({
      id: 5,
      reconciliationStatus: 'duplicate',
      canonicalRowID: '1',
      requestKey: 'summary:req-other',
    }),
  ];

  assert.throws(() => planCanonicalReconciliation(rows, []), /attempt request key mismatch/i);
});

test('fails closed when any attempt row has a missing request key', () => {
  const rows = [
    attempt(),
    attempt({ id: 4, reconciliationStatus: 'pending', canonicalRowID: '', requestKey: undefined }),
  ];

  assert.throws(() => planCanonicalReconciliation(rows, []), /invalid attempt request key/i);
});

test('rejects malformed reconciliation states before election or repair decisions', () => {
  const cases = [
    ['unknown status', attempt({ reconciliationStatus: 'winner' })],
    ['canonical not self', attempt({ canonicalRowID: 'row-other' })],
    ['pending with canonical target', attempt({ reconciliationStatus: 'pending', canonicalRowID: '1' })],
    ['duplicate without canonical target', attempt({ reconciliationStatus: 'duplicate', canonicalRowID: '' })],
    ['missing id', attempt({ id: '' })],
    ['missing createdAt', attempt({ createdAt: '' })],
    ['missing updatedAt', attempt({ updatedAt: '' })],
  ];

  for (const [label, row] of cases) {
    assert.throws(
      () => planCanonicalReconciliation([row], []),
      /invalid reconciliation|canonical row|pending row|duplicate row|required system field/i,
      label,
    );
  }
});

test('handles already-applied, zero-CAS reread, mismatch, and fallback-CAS-miss final states', () => {
  const { confirmFinalFallback, verifyFinalState } = loadStateVerifier();
  const expected = {
    classification: 'accepted',
    status: 'waiting_callback',
    submittedAtIso: NOW,
    callbackDeadlineAtIso: '2026-08-23T00:00:00.000Z',
    attemptKey: attempt().attemptKey,
    dispatchLeaseOwner: 'exec-1',
    dispatchLeaseUntilIso: '2026-08-23T00:00:00.000Z',
  };
  const ownedDispatching = attempt({
    status: 'dispatching',
    dispatchLeaseOwner: 'exec-1',
    dispatchLeaseUntilIso: expected.dispatchLeaseUntilIso,
  });
  const applied = {
    ...ownedDispatching,
    status: 'waiting_callback',
    submittedAtIso: NOW,
    callbackDeadlineAtIso: expected.callbackDeadlineAtIso,
    dispatchLeaseOwner: '',
    dispatchLeaseUntilIso: '',
    errorCode: '',
  };

  assert.equal(verifyFinalState([applied], expected, 'exec-1').action, 'verified');
  assert.deepEqual(verifyFinalState([ownedDispatching], expected, 'exec-1'), {
    action: 'fallback',
    fallbackRowID: 1,
    id: 1,
    attemptKey: expected.attemptKey,
    expectedStatus: 'dispatching',
    expectedReconciliationStatus: 'canonical',
    expectedCanonicalRowID: '1',
    expectedDispatchLeaseOwner: 'exec-1',
    expectedDispatchLeaseUntilIso: expected.dispatchLeaseUntilIso,
    desiredStatus: 'manual_review',
    manualReviewReason: 'vds_submit_result_patch_unconfirmed',
  });
  assert.throws(
    () => verifyFinalState([{ ...applied, status: 'retry_pending' }], expected, 'exec-1'),
    /final state mismatch/i,
  );
  assert.throws(
    () => verifyFinalState([{ ...ownedDispatching, dispatchLeaseOwner: 'exec-other' }], expected, 'exec-1'),
    /final state mismatch/i,
  );
  assert.throws(
    () => verifyFinalState([{ ...ownedDispatching, reconciliationStatus: 'duplicate' }], expected, 'exec-1'),
    /exactly one canonical/i,
  );
  assert.throws(
    () => verifyFinalState([applied], { ...expected, status: 'failed' }, 'exec-1'),
    /invalid expected final classification/i,
  );
  const confirmed = {
    ...ownedDispatching,
    status: 'manual_review',
    manualReviewReason: 'vds_submit_result_patch_unconfirmed',
    manualReviewAtIso: '2026-08-22T00:00:01.000Z',
    nextRetryAtIso: '',
    dispatchLeaseOwner: '',
    dispatchLeaseUntilIso: '',
  };
  assert.equal(confirmFinalFallback([confirmed], 1).action, 'verified_fallback');
  assert.throws(() => confirmFinalFallback([ownedDispatching], 1), /fallback.*unconfirmed|fallback.*mismatch/i);
  assert.throws(() => confirmFinalFallback([{ ...confirmed, id: 6, canonicalRowID: '6' }], 1), /fallback row.*mismatch/i);
  assert.throws(() => confirmFinalFallback([{ ...confirmed, nextRetryAtIso: '2026-08-22T00:05:00.000Z' }], 1), /fallback.*mismatch/i);
  assert.throws(() => confirmFinalFallback([{ ...confirmed, manualReviewAtIso: '' }], 1), /manual review time/i);
  assert.throws(() => confirmFinalFallback([{ ...confirmed, manualReviewAtIso: 'not-an-iso' }], 1), /manual review time/i);
});

test('verifies every expected competing canonical was frozen without partial CAS', () => {
  const { verifyFrozenConflict } = loadStateVerifier();
  const expected = [{ id: 1 }, { id: 2 }];
  const frozen = expected.map(({ id }) => attempt({
    id,
    canonicalRowID: String(id),
    status: 'manual_review',
    manualReviewReason: 'multiple_canonical_checkpoint_conflict',
  }));

  assert.equal(verifyFrozenConflict(frozen, expected).action, 'verified_conflict');
  assert.throws(() => verifyFrozenConflict(frozen.slice(0, 1), expected), /frozen conflict.*missing|expected competing/i);
  assert.throws(
    () => verifyFrozenConflict([{ ...frozen[0], status: 'dispatching' }, frozen[1]], expected),
    /frozen conflict.*mismatch/i,
  );
});

test('uses the converged post-reconciliation conflict plan when a new canonical wins the race', () => {
  const { verifyFrozenConflict } = loadStateVerifier();
  const initialRows = [
    attempt({ id: 1, canonicalRowID: '1' }),
    attempt({ id: 2, canonicalRowID: '2' }),
  ];
  const initialPlan = planCanonicalReconciliation(initialRows, []);
  assert.equal(initialPlan.action, 'reconcile');
  assert.deepEqual(initialPlan.mutations.map(({ id }) => id), [2]);

  const racedRows = [
    ...initialRows,
    attempt({
      id: 3,
      canonicalRowID: '3',
      submittedAtIso: '2026-08-22T00:00:01.000Z',
    }),
  ];
  const convergedPlan = planCanonicalReconciliation(racedRows, []);
  assert.equal(convergedPlan.action, 'manual_review');
  assert.deepEqual(convergedPlan.mutations.map(({ id }) => id), [1, 2, 3]);

  const frozen = racedRows.map((row) => ({
    ...row,
    status: 'manual_review',
    manualReviewReason: 'multiple_canonical_checkpoint_conflict',
  }));
  assert.equal(verifyFrozenConflict(frozen, convergedPlan.mutations).action, 'verified_conflict');
  assert.throws(
    () => verifyFrozenConflict(frozen, initialPlan.mutations),
    /expected competing|frozen conflict/i,
  );
});

test('requires exactly one canonical row owned by the current dispatch lease', () => {
  const owned = attempt({
    status: 'dispatching',
    dispatchLeaseOwner: 'exec-1',
    dispatchLeaseUntilIso: '2026-08-23T00:00:00.000Z',
  });
  assert.deepEqual(requireCanonicalOwner([owned], 'exec-1', NOW), owned);
  assert.throws(() => requireCanonicalOwner([owned, { ...owned, id: 2 }], 'exec-1', NOW), /exactly one canonical/i);
  assert.throws(() => requireCanonicalOwner([owned], 'exec-2', NOW), /lease owner/i);
  assert.throws(() => requireCanonicalOwner([owned], 'exec-1', '2026-08-23T00:00:00.000Z'), /lease expired/i);
  assert.throws(() => requireCanonicalOwner([owned], 'exec-1', '2026-08-23T00:00:00.001Z'), /lease expired/i);
  assert.throws(
    () => requireCanonicalOwner([{ ...owned, dispatchLeaseUntilIso: 'not-an-iso-date' }], 'exec-1', NOW),
    /invalid dispatch lease/i,
  );
  assert.throws(
    () => requireCanonicalOwner([{ ...owned, dispatchLeaseUntilIso: '2026-02-31T00:05:00.000Z' }], 'exec-1', NOW),
    /invalid dispatch lease/i,
  );
  assert.throws(() => requireCanonicalOwner([owned], 'exec-1', 'invalid-now'), /invalid current time/i);
});

test('keeps the shared active state with one typed Execute Workflow Trigger and UUIDv4 node IDs', () => {
  const workflow = readWorkflow();
  const triggers = workflow.nodes.filter(({ type }) => type.toLowerCase().includes('trigger'));
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  assert.equal(workflow.id, 'STTDispatchV3A01');
  assert.equal(workflow.name, 'STT: dispatch attempt v3');
  assert.equal(workflow.active, true);
  assert.equal(workflow.isArchived, false);
  assert.deepEqual(triggers.map(({ type }) => type), ['n8n-nodes-base.executeWorkflowTrigger']);
  assert.deepEqual(triggers[0].parameters.workflowInputs.values, [{ name: 'attemptKey', type: 'string' }]);
  assert.ok(workflow.nodes.every(({ id }) => uuidV4.test(id)));
  assert.equal(new Set(workflow.nodes.map(({ id }) => id)).size, workflow.nodes.length);
  assert.equal(new Set(workflow.nodes.map(({ name }) => name)).size, workflow.nodes.length);
  const nodeNames = new Set(workflow.nodes.map(({ name }) => name));
  for (const outputs of Object.values(workflow.connections)) {
    for (const output of outputs.main || []) {
      for (const connection of output || []) assert.ok(nodeNames.has(connection.node), connection.node);
    }
  }
});

test('keeps authoritative source placeholders and remaps every Data Table to its exact P3 runtime ID', () => {
  const workflow = readWorkflow();
  const dataTableNodes = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.dataTable');
  const updates = dataTableNodes.filter(({ parameters }) => parameters.operation === 'update');
  const summaryReads = dataTableNodes.filter(({ parameters }) => parameters.dataTableId.value === 'summary_requests_v3');

  assert.ok(dataTableNodes.length > 0);
  assert.equal(collectDataTableReferences([workflow]).length, dataTableNodes.length);
  assert.ok(updates.length >= 7);
  for (const node of dataTableNodes) {
    assert.equal(node.typeVersion, 1, node.name);
    assert.equal(node.parameters.dataTableId.__rl, true, node.name);
    assert.equal(node.parameters.dataTableId.mode, 'name', node.name);
    assert.ok(['stt_jobs_v3', 'summary_requests_v3'].includes(node.parameters.dataTableId.value), node.name);
  }
  const runtimeNodes = remapDataTableReferences(workflow.nodes, P3_DATA_TABLE_IDS);
  const runtimeDataTables = runtimeNodes.filter(({ type }) => type === 'n8n-nodes-base.dataTable');
  for (const node of runtimeDataTables) {
    const source = nodeByName(workflow, node.name);
    assert.equal(source.parameters.dataTableId.mode, 'name', node.name);
    assert.deepEqual(node.parameters.dataTableId, {
      __rl: true,
      mode: 'id',
      value: P3_DATA_TABLE_IDS.get(source.parameters.dataTableId.value),
    }, node.name);
  }
  assert.equal(summaryReads.length, 2);
  assert.ok(summaryReads.every(({ parameters, alwaysOutputData }) => parameters.operation === 'get' && parameters.returnAll === true && alwaysOutputData === true));
  assert.ok(updates.every(({ parameters }) => parameters.dataTableId.value === 'stt_jobs_v3'));
  for (const node of updates) {
    const filters = filterMap(node);
    assert.equal(node.parameters.matchType, 'allConditions', node.name);
    assert.equal(filters.attemptKey?.condition, 'eq', node.name);
    assert.equal(filters.reconciliationStatus?.condition, 'eq', node.name);
    assert.equal(node.parameters.columns.mappingMode, 'defineBelow', node.name);
  }

  const claim = nodeByName(workflow, 'Claim Canonical Attempt');
  const claimFilters = filterMap(claim);
  assert.equal(claimFilters.attemptKey.keyValue, "={{ $('Start').first().json.attemptKey }}");
  assert.equal(claimFilters.status.keyValue, 'queued');
  assert.equal(claimFilters.reconciliationStatus.keyValue, 'canonical');
  assert.equal(claim.parameters.columns.value.status, 'dispatching');
  assert.equal(claim.parameters.columns.value.dispatchLeaseOwner, '={{ $execution.id }}');
  assert.equal(claim.parameters.columns.value.dispatchLeaseUntilIso, '={{ $now.plus({ hours: 24 }).toUTC().toISO() }}');
});

test('implements reconciliation, claim Limit 1, and exact canonical owner re-reads', () => {
  const workflow = readWorkflow();
  const reconciliationCode = fs.readFileSync(reconciliationCodePath, 'utf8');
  const ownerCode = fs.readFileSync(ownerCodePath, 'utf8');

  assert.deepEqual(targets(workflow, 'Start'), ['Read All Attempt Rows']);
  assert.deepEqual(targets(workflow, 'Read All Attempt Rows'), ['Limit Attempt Context']);
  assert.deepEqual(targets(workflow, 'Limit Attempt Context'), ['Read Summary Request Rows']);
  assert.deepEqual(targets(workflow, 'Read Summary Request Rows'), ['Plan Canonical Reconciliation']);
  assert.deepEqual(targets(workflow, 'Apply Reconciliation'), ['Limit Reconciliation Writes']);
  assert.deepEqual(targets(workflow, 'Limit Reconciliation Writes'), ['Re-read After Reconciliation']);
  assert.deepEqual(targets(workflow, 'Re-read After Reconciliation'), ['Limit Reconciled Context']);
  assert.deepEqual(targets(workflow, 'Limit Reconciled Context'), ['Read Summary Rows After Reconciliation']);
  assert.deepEqual(targets(workflow, 'Read Summary Rows After Reconciliation'), ['Verify Reconciled Canonical']);
  assert.deepEqual(targets(workflow, 'Claim Canonical Attempt'), ['Limit Claim']);
  assert.deepEqual(targets(workflow, 'Limit Claim'), ['Re-read Claimed Attempt']);
  assert.deepEqual(targets(workflow, 'Re-read Claimed Attempt'), ['Require Canonical Owner']);
  assert.deepEqual(targets(workflow, 'Persist Token Hash'), ['Limit Token Patch']);
  assert.deepEqual(targets(workflow, 'Limit Token Patch'), ['Re-read Before Submit']);
  assert.deepEqual(targets(workflow, 'Re-read Before Submit'), ['Require Canonical Owner Before Submit']);

  assert.equal(nodeByName(workflow, 'Limit Attempt Context').parameters.maxItems, 1);
  assert.equal(nodeByName(workflow, 'Limit Reconciliation Writes').parameters.maxItems, 1);
  assert.equal(nodeByName(workflow, 'Limit Reconciled Context').parameters.maxItems, 1);
  assert.equal(nodeByName(workflow, 'Limit Claim').parameters.maxItems, 1);
  assert.equal(nodeByName(workflow, 'Limit Token Patch').parameters.maxItems, 1);
  assert.match(reconciliationCode, /\$\('Read All Attempt Rows'\)\.all\(\)/);
  assert.match(reconciliationCode, /\$input\.all\(\)/);
  assert.match(ownerCode, /new Date\(\)\.toISOString\(\)/);
});

test('keeps lease-valid owner gates before both Crypto and HTTP side effects', () => {
  const workflow = readWorkflow();
  const ownerReference = '__EXTERNAL_FILE__://nodes/Require_Canonical_Owner/jsCode.js';

  assert.equal(nodeByName(workflow, 'Require Canonical Owner').parameters.jsCode, ownerReference);
  assert.equal(nodeByName(workflow, 'Require Canonical Owner Before Submit').parameters.jsCode, ownerReference);
  assert.deepEqual(targets(workflow, 'Re-read Claimed Attempt'), ['Require Canonical Owner']);
  assert.deepEqual(targets(workflow, 'Require Canonical Owner'), ['Generate Callback Token']);
  assert.deepEqual(targets(workflow, 'Re-read Before Submit'), ['Require Canonical Owner Before Submit']);
  assert.deepEqual(targets(workflow, 'Require Canonical Owner Before Submit'), ['Token Hash Persisted']);
  assert.equal(reachableNodes(workflow, 'Generate Callback Token').has('Require Canonical Owner'), false);
  assert.equal(reachableNodes(workflow, 'Submit VDS Segment').has('Require Canonical Owner Before Submit'), false);
});

test('ends checkpoint-conflict processing after manual-review patch and re-read with zero side effects', () => {
  const workflow = readWorkflow();
  const reachable = reachableNodes(workflow, 'Freeze Canonical Conflict');

  assert.equal(nodeByName(workflow, 'Freeze Conflict Plan').type, 'n8n-nodes-base.noOp');
  assert.deepEqual(targets(workflow, 'Is Manual Review Conflict', 0), ['Freeze Conflict Plan']);
  assert.deepEqual(targets(workflow, 'Post-Reconciliation Conflict', 0), ['Freeze Conflict Plan']);
  assert.deepEqual(targets(workflow, 'Freeze Conflict Plan'), ['Freeze Canonical Conflict']);
  assert.deepEqual(targets(workflow, 'Freeze Canonical Conflict'), ['Limit Conflict Patch']);
  assert.deepEqual(targets(workflow, 'Limit Conflict Patch'), ['Re-read Manual Review State']);
  assert.equal(nodeByName(workflow, 'Freeze Canonical Conflict').alwaysOutputData, true);
  assert.deepEqual(targets(workflow, 'Re-read Manual Review State'), ['Verify Frozen Conflict']);
  assert.deepEqual(targets(workflow, 'Verify Frozen Conflict'), []);
  const verifierCode = fs.readFileSync(stateVerifierCodePath, 'utf8');
  assert.match(verifierCode, /\$\('Freeze Conflict Plan'\)\.all\(\)/);
  assert.doesNotMatch(verifierCode, /\$\('Plan Canonical Reconciliation'\)\.all\(\)/);
  for (const forbidden of [
    'Claim Canonical Attempt',
    'Generate Callback Token',
    'Hash Callback Token',
    'Build VDS Payload',
    'Submit VDS Segment',
    'Classify ACK',
  ]) {
    assert.equal(reachable.has(forbidden), false, forbidden);
  }
});

test('uses native Crypto nodes for a 32-byte opaque token and SHA-256 hash', () => {
  const workflow = readWorkflow();
  const generate = nodeByName(workflow, 'Generate Callback Token');
  const hash = nodeByName(workflow, 'Hash Callback Token');
  const payloadCode = fs.readFileSync(payloadCodePath, 'utf8');
  const allCode = [payloadCode, ackCodePath, reconciliationCodePath, ownerCodePath, stateVerifierCodePath]
    .map((file) => file === payloadCode ? file : fs.readFileSync(file, 'utf8'))
    .join('\n');

  assert.equal(generate.type, 'n8n-nodes-base.crypto');
  assert.equal(generate.typeVersion, 1);
  assert.deepEqual(generate.parameters, {
    action: 'generate',
    dataPropertyName: 'callbackToken',
    encodingType: 'hex',
    stringLength: 64,
  });
  assert.equal(hash.type, 'n8n-nodes-base.crypto');
  assert.equal(hash.typeVersion, 1);
  assert.deepEqual(hash.parameters, {
    action: 'hash',
    type: 'SHA256',
    binaryData: false,
    value: '={{ $json.callbackToken }}',
    dataPropertyName: 'callbackTokenHash',
    encoding: 'hex',
  });
  assert.doesNotMatch(allCode, /require\s*\(\s*['"](?:node:)?crypto['"]\s*\)/);
  assert.doesNotMatch(allCode, /console\.(?:log|debug|info|warn|error)/);
});

test('persists only token hash and twenty-four-hour expiry before the VDS submit', () => {
  const workflow = readWorkflow();
  const persist = nodeByName(workflow, 'Persist Token Hash');
  const serializedPersist = JSON.stringify(persist.parameters);
  const persistFilters = filterMap(persist);

  assert.equal(persistFilters.status.keyValue, 'dispatching');
  assert.equal(persistFilters.reconciliationStatus.keyValue, 'canonical');
  assert.equal(persistFilters.dispatchLeaseOwner.keyValue, '={{ $execution.id }}');
  assert.match(persistFilters.dispatchLeaseUntilIso.keyValue, /Require Canonical Owner/);
  assert.equal(persist.parameters.columns.value.callbackTokenHash, '={{ $json.callbackTokenHash }}');
  assert.equal(persist.parameters.columns.value.callbackTokenExpiresAtIso, '={{ $now.plus({ hours: 24 }).toUTC().toISO() }}');
  assert.doesNotMatch(serializedPersist, /[".]callbackToken["}]/);
  assert.deepEqual(targets(workflow, 'Hash Callback Token'), ['Persist Token Hash']);
  assert.deepEqual(targets(workflow, 'Require Canonical Owner Before Submit'), ['Token Hash Persisted']);
  assert.deepEqual(targets(workflow, 'Token Hash Persisted', 0), ['Attach Callback URL']);
  assert.deepEqual(targets(workflow, 'Build VDS Payload'), ['Submit VDS Segment']);
});

test('uses the deployment callback placeholder and exact VDS HTTP credential with disabled retry and a wired error output', () => {
  const workflow = readWorkflow();
  const attachUrl = nodeByName(workflow, 'Attach Callback URL');
  const request = nodeByName(workflow, 'Submit VDS Segment');

  assert.equal(attachUrl.parameters.assignments.assignments[0].value, '__DEPLOY_STT_CALLBACK_URL__');
  assert.equal(request.parameters.method, 'POST');
  assert.equal(request.parameters.url, 'https://stt-api.17app.co/api/v1/stream/conversions/segment');
  assert.equal(request.parameters.authentication, 'genericCredentialType');
  assert.equal(request.parameters.genericAuthType, 'httpHeaderAuth');
  assert.equal(request.parameters.sendBody, true);
  assert.equal(request.parameters.specifyBody, 'json');
  assert.equal(request.parameters.jsonBody, '={{ $json }}');
  assert.equal(request.parameters.options.response.response.fullResponse, true);
  assert.equal(request.parameters.options.response.response.neverError, true);
  assert.equal(request.retryOnFail, false);
  assert.equal(request.onError, 'continueErrorOutput');
  assert.deepEqual(request.credentials, {
    httpHeaderAuth: { id: 'b39tXWu6AGQsbY2C', name: 'Header Auth account 2' },
  });
  assert.deepEqual(targets(workflow, 'Submit VDS Segment', 0), ['Classify ACK']);
  assert.deepEqual(targets(workflow, 'Submit VDS Segment', 1), ['Mark Transport Outcome']);
  assert.deepEqual(targets(workflow, 'Mark Transport Outcome'), ['Classify ACK']);
});

test('routes ACK classes to canonical final patches with Limit 1 and re-read', () => {
  const workflow = readWorkflow();
  const finalUpdates = [
    ['Patch Accepted', 'waiting_callback'],
    ['Patch Retry Pending', 'retry_pending'],
    ['Patch Failed', 'failed'],
    ['Patch Manual Review', 'manual_review'],
  ];

  for (const [name, status] of finalUpdates) {
    const node = nodeByName(workflow, name);
    const filters = filterMap(node);
    assert.equal(filters.status.keyValue, 'dispatching', name);
    assert.equal(filters.reconciliationStatus.keyValue, 'canonical', name);
    assert.equal(filters.dispatchLeaseOwner.keyValue, '={{ $execution.id }}', name);
    assert.ok(filters.dispatchLeaseUntilIso, name);
    assert.equal(node.parameters.columns.value.status, status, name);
    assert.equal(node.alwaysOutputData, true, name);
    assert.deepEqual(targets(workflow, name), [`Limit ${name.replace('Patch ', '')} Patch`]);
    assert.deepEqual(targets(workflow, `Limit ${name.replace('Patch ', '')} Patch`), ['Re-read Final State']);
  }

  assert.equal(nodeByName(workflow, 'Patch Accepted').parameters.columns.value.submittedAtIso, '={{ $json.submittedAtIso }}');
  assert.equal(nodeByName(workflow, 'Patch Accepted').parameters.columns.value.callbackDeadlineAtIso, '={{ $json.callbackDeadlineAtIso }}');
  assert.equal(nodeByName(workflow, 'Patch Retry Pending').parameters.columns.value.nextRetryAtIso, '={{ $json.nextRetryAtIso }}');
  assert.equal(nodeByName(workflow, 'Patch Manual Review').parameters.columns.value.manualReviewReason, 'vds_submit_outcome_ambiguous');
  assert.equal(targets(workflow, 'Patch Manual Review').length, 1);
  assert.deepEqual(targets(workflow, 'Re-read Final State'), ['Verify Final State']);
  assert.deepEqual(targets(workflow, 'Verify Final State'), ['Needs Final State Fallback', 'Trigger Terminal Presentation']);
  assert.deepEqual(targets(workflow, 'Trigger Terminal Presentation', 0), ['Run Terminal Presentation']);
  assert.deepEqual(targets(workflow, 'Trigger Terminal Presentation', 1), []);
  assert.deepEqual(targets(workflow, 'Needs Final State Fallback', 0), ['Patch Final State Unconfirmed']);
  assert.deepEqual(targets(workflow, 'Patch Final State Unconfirmed'), ['Limit Final State Fallback']);
  assert.deepEqual(targets(workflow, 'Limit Final State Fallback'), ['Re-read Final Fallback']);
  assert.deepEqual(targets(workflow, 'Re-read Final Fallback'), ['Verify Final Fallback']);
  assert.deepEqual(targets(workflow, 'Verify Final Fallback'), []);
  const verifierCode = fs.readFileSync(stateVerifierCodePath, 'utf8');
  assert.match(verifierCode, /\$\('Verify Final State'\)\.first\(\)\.json\.fallbackRowID/);
  const fallback = nodeByName(workflow, 'Patch Final State Unconfirmed');
  const fallbackFilters = filterMap(fallback);
  assert.equal(fallback.parameters.matchType, 'allConditions');
  assert.equal(fallbackFilters.id.keyValue, '={{ $json.id }}');
  assert.equal(fallbackFilters.status.keyValue, '={{ $json.expectedStatus }}');
  assert.equal(fallbackFilters.reconciliationStatus.keyValue, '={{ $json.expectedReconciliationStatus }}');
  assert.equal(fallbackFilters.canonicalRowID.keyValue, '={{ $json.expectedCanonicalRowID }}');
  assert.equal(fallbackFilters.dispatchLeaseOwner.keyValue, '={{ $json.expectedDispatchLeaseOwner }}');
  assert.equal(fallbackFilters.dispatchLeaseUntilIso.keyValue, '={{ $json.expectedDispatchLeaseUntilIso }}');
  assert.equal(fallback.parameters.columns.value.manualReviewReason, 'vds_submit_result_patch_unconfirmed');
  assert.equal(fallback.alwaysOutputData, true);
});

test('uses the approved execution retention settings', () => {
  const settings = readWorkflow().settings;
  assert.deepEqual(Object.fromEntries(['saveDataSuccessExecution', 'saveDataErrorExecution', 'saveManualExecutions', 'saveExecutionProgress'].map((key) => [key, settings[key]])), {
    saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true, saveExecutionProgress: false,
  });
});

test('does not place raw token or hash in URLs, database token fields, or logging code', () => {
  const workflow = readWorkflow();
  const urls = workflow.nodes.flatMap(({ parameters }) => parameters.url ? [parameters.url] : []);
  const dataTableText = JSON.stringify(workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.dataTable'));
  const code = [payloadCodePath, ackCodePath, reconciliationCodePath, ownerCodePath, stateVerifierCodePath]
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');

  assert.ok(urls.every((url) => !/callbackToken|callbackTokenHash|token=|hash=/i.test(url)));
  assert.doesNotMatch(dataTableText, /"callbackToken"/);
  assert.doesNotMatch(code, /console\.(?:log|debug|info|warn|error)/);
  assert.doesNotMatch(code, /\$execution\.resumeUrl|resumeUrl/);
});
