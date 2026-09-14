const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const { parseBotItem } = require('../workflows/ist_bot_entry_v3_IstBotEntryV3A01/nodes/Command_parser/jsCode');
const { normalizeSummaryCommand } = require('../workflows/ist_bot_entry_v3_IstBotEntryV3A01/nodes/Build_Summary_Resolver_Input/jsCode');
const {
  planAfterBaseDiscovery,
  buildOrderedSummaryStreams,
} = require('../workflows/ist_bot_entry_v3_IstBotEntryV3A01/nodes/Reassemble_Summary_Resolver_Output/jsCode');
const { normalizeRequest } = require('../workflows/summary_orchestrate_request_v3_SummaryOrchV3A01/nodes/Normalize_Request/jsCode');
const { buildAttempts } = require('../workflows/summary_orchestrate_request_v3_SummaryOrchV3A01/nodes/Build_Attempts/jsCode');
const { buildVdsPayload } = require('../workflows/stt_dispatch_attempt_v3_STTDispatchV3A01/nodes/Build_VDS_Payload/jsCode');
const { classifyAck } = require('../workflows/stt_dispatch_attempt_v3_STTDispatchV3A01/nodes/Classify_ACK/jsCode');
const { normalizeCallback } = require('../workflows/stt_callback_ingress_v3_STTCallbackV3A1/nodes/Normalize_Callback/jsCode');
const { classifyClaim } = require('../workflows/stt_callback_ingress_v3_STTCallbackV3A1/nodes/Classify_Claim/jsCode');
const { aggregateLogicalJobs } = require('../workflows/summary_coordinator_v3_SummaryCoordV3A1/nodes/Aggregate_Logical_Jobs/jsCode');
const { preflightAI } = require('../workflows/summary_coordinator_v3_SummaryCoordV3A1/nodes/Preflight_AI/jsCode');
const { buildSummaryInput } = require('../workflows/summary_coordinator_v3_SummaryCoordV3A1/nodes/Build_Summary_Input/jsCode');
const aiSummary = require('../workflows/ai_summary_v3_AISummaryV3A0001/nodes/Finalize_Request/jsCode');
const { buildInferenceAggregate } = require('../workflows/ai_summary_v3_AISummaryV3A0001/nodes/group_streamID/jsCode');
const { classifyAttemptFailure } = require('../workflows/repair_process_candidate_v3_RepairCandidateV3A1/nodes/Plan_Repairs/jsCode');
const { renderSummaryMarkdown } = require('../workflows/ai_summary_v3_AISummaryV3A0001/nodes/Render_Summary_Markdown/jsCode');

const CHANNEL = 'C0A4JJJKJMD';
const NOW = '2026-08-22T00:00:00.000Z';
const TOKEN = 'a'.repeat(64);
const HASH = 'b'.repeat(64);
const CALLBACK_URL = 'https://n8n.example/webhook/stt-callback-v3';

function metadata(overrides = {}) {
  return {
    inputIndex: 0,
    status: 'found',
    source: 'livestream_v2',
    profile: 'stt',
    liveStreamID: '9001',
    userID: 'user-9001',
    openID: 'open-9001',
    beginTime: 1735689600,
    endTime: 1735697401,
    duration: 7801,
    region: 'TW',
    vliverModel: 1,
    appVersion: '3.4.5',
    deviceType: 'ios',
    eligible: true,
    closeBy: 'normalEnd',
    ...overrides,
  };
}

function callbackContext(attempt) {
  return {
    attemptKey: attempt.attemptKey,
    logicalJobKey: attempt.logicalJobKey,
    requestKey: attempt.requestKey,
    requestType: attempt.requestType,
    streamID: attempt.streamID,
    mode: attempt.mode,
    channel: attempt.channel,
    threadTS: attempt.threadTS,
    processingMessageTS: attempt.processingMessageTS,
    callbackToken: TOKEN,
  };
}

function persistedAttempt(attempt, overrides = {}) {
  return {
    id: 201,
    createdAt: NOW,
    updatedAt: NOW,
    ...attempt,
    role: 'current',
    status: 'waiting_callback',
    callbackTokenHash: HASH,
    callbackTokenExpiresAtIso: '2026-08-23T00:00:00.000Z',
    callbackDeadlineAtIso: '2026-08-22T00:01:00.000Z',
    consumedAtIso: '',
    dialogue: '',
    language: '',
    errorCode: '',
    nextRetryAtIso: '',
    presentationStatus: 'pending',
    manualReviewResolution: '',
    reconciliationStatus: 'canonical',
    canonicalRowID: '201',
    ...overrides,
  };
}

function coordinatorRequest(normalized, streams, aggregate) {
  return {
    id: 101,
    createdAt: NOW,
    updatedAt: NOW,
    requestKey: normalized.requestKey,
    requestType: normalized.requestType,
    status: 'summary_dispatching',
    reconciliationStatus: 'canonical',
    canonicalRowID: '101',
    orderedStreamsJson: JSON.stringify(streams),
    existingDialoguesJson: normalized.existingDialoguesJson,
    expectedLogicalJobKeysJson: normalized.expectedLogicalJobKeysJson,
    channel: normalized.channel,
    threadTS: normalized.threadTS,
    coverageStatus: aggregate.coverageStatus,
    availableRolesJson: JSON.stringify(aggregate.availableRoles),
    missingRolesJson: JSON.stringify(aggregate.missingRoles),
    failedLogicalJobKeysJson: JSON.stringify(aggregate.failedLogicalJobKeys),
    leaseOwner: 'exec-single',
    leaseUntilIso: '2026-08-22T03:00:00.000Z',
  };
}

for (const group of ['summary', 'stt']) test(`runs ${group} full-stream offline from Slack command through AI aggregate`, () => {
  const messageTS = '1787364000.000002';
  const command = parseBotItem({ event: {
    channel: CHANNEL,
    ts: messageTS,
    event_ts: messageTS,
    text: `!${group} stream 9001 date=2025-01-02`,
  } });
  const plan = normalizeSummaryCommand(command, '2025-02-01T09:17:00+08:00');
  assert.equal(command.dispatchKey, 'v3:summary:stream');
  assert.equal(plan.requestType, 'single_stream_summary');
  assert.deepEqual(plan.lookupWindow, {
    start: '2024-12-31T04:00:00+08:00', end: '2025-01-05T04:00:00+08:00',
  });
  assert.equal(Date.parse(plan.lookupWindow.end) - Date.parse(plan.lookupWindow.start), 5 * 24 * 60 * 60 * 1000);

  const resolved = metadata();
  const resolverCalls = planAfterBaseDiscovery(plan, [resolved]);
  assert.deepEqual(resolverCalls.map(({ phase, streams, lookupWindow }) => ({ phase, streams, lookupWindow })), [{
    phase: 'final', streams: [{ liveStreamID: '9001' }], lookupWindow: plan.lookupWindow,
  }]);
  const streams = buildOrderedSummaryStreams(plan, [resolved]).map((stream) => ({
    ...stream,
    processingMessageTS: '1787364000.000003',
  }));
  assert.deepEqual(streams.map(({ role, liveStreamID, mode, durationMinutes }) => ({ role, liveStreamID, mode, durationMinutes })), [{
    role: 'current', liveStreamID: '9001', mode: 'fromStart', durationMinutes: 131,
  }]);

  const normalized = normalizeRequest({
    requestKey: plan.requestKey,
    requestType: plan.requestType,
    orderedStreams: streams,
    existingDialogues: {},
    channel: plan.channel,
    threadTS: plan.threadTS,
  });
  const [queued] = buildAttempts(normalized, NOW);
  assert.equal(queued.logicalJobKey, `${plan.requestKey}:current:9001:fromStart`);
  assert.equal(queued.attemptKey, `${queued.logicalJobKey}:1`);

  const payload = buildVdsPayload(queued, TOKEN, CALLBACK_URL, Date.parse(NOW));
  assert.deepEqual(payload.streamSegment, { mode: 'fromStart', durationMinutes: 131 });
  assert.deepEqual(payload.webhookConfiguration.context, callbackContext(queued));
  const accepted = classifyAck({ statusCode: 202 }, queued, [{
    id: 101,
    requestKey: plan.requestKey,
    requestType: plan.requestType,
    reconciliationStatus: 'canonical',
    canonicalRowID: '101',
    createdAt: NOW,
  }], NOW);
  assert.equal(accepted.status, 'waiting_callback');
  assert.equal(accepted.callbackDeadlineAtIso, '2026-08-22T00:01:00.000Z');

  const callback = normalizeCallback({ body: {
    statusCode: 200,
    transcription: '完整逐字稿',
    languages: ['zh'],
    webhook: { context: callbackContext(queued) },
  } });
  assert.equal(callback.valid, true);
  const completed = persistedAttempt(queued);
  const claim = classifyClaim([completed], callback, HASH, '2026-08-22T00:00:30.000Z', [completed]);
  assert.equal(claim.desiredStatus, 'completed');
  const aggregate = aggregateLogicalJobs(
    { ...coordinatorRequest(normalized, streams, { coverageStatus: 'waiting_stt', availableRoles: [], missingRoles: ['current'], failedLogicalJobKeys: [] }), status: 'waiting_stt' },
    [persistedAttempt(queued, { status: 'completed', consumedAtIso: '2026-08-22T00:00:30.000Z', dialogue: claim.dialogue, language: claim.language })],
  );
  assert.equal(aggregate.coverageStatus, 'complete');
  assert.equal(aggregate.streams[0].dialogue, '完整逐字稿');

  const request = coordinatorRequest(normalized, streams, aggregate);
  const preflight = preflightAI([request], [persistedAttempt(queued, {
    status: 'completed', consumedAtIso: '2026-08-22T00:00:30.000Z', dialogue: claim.dialogue, language: claim.language,
  })], plan.requestKey, 'exec-single', '2026-08-22T00:00:30.000Z');
  assert.equal(preflight.action, 'ai');
  const aiInput = buildSummaryInput(preflight, preflight);
  assert.equal(aiSummary.validateInput(aiInput), aiInput);
  assert.equal(buildInferenceAggregate(aiInput, [{ liveStreamID: '9001', evidenceType: 'streamerLog', Type: 'PushReport' }]).streams[0].details[0].dialogue, '完整逐字稿');
});

test('keeps old dual-stream five-minute payloads unchanged and does not promote empty or timed-out single coverage', () => {
  const plan = normalizeSummaryCommand({
    routeKey: 'summary:stream', channel: CHANNEL, ts: '1787364000.000002', args: {}, positionals: ['8001', '9001'],
  }, '2025-02-01T09:17:00+08:00');
  const streams = buildOrderedSummaryStreams(plan, [metadata({ inputIndex: 0, liveStreamID: '8001' }), metadata({ inputIndex: 1 })]);
  assert.deepEqual(streams.map(({ role, mode, durationMinutes }) => ({ role, mode, durationMinutes })), [
    { role: 'previous', mode: 'fromEnd', durationMinutes: 5 },
    { role: 'current', mode: 'fromStart', durationMinutes: 5 },
  ]);

  const singlePlan = normalizeSummaryCommand({
    routeKey: 'summary:stream', channel: CHANNEL, ts: '1787364000.000003', args: {}, positionals: ['9001'],
  });
  const singleStreams = buildOrderedSummaryStreams(singlePlan, [metadata()]).map((stream) => ({
    ...stream,
    processingMessageTS: '1787364000.000004',
  }));
  const normalized = normalizeRequest({ requestKey: singlePlan.requestKey, requestType: singlePlan.requestType, orderedStreams: singleStreams, existingDialogues: {}, channel: CHANNEL, threadTS: singlePlan.threadTS });
  const [queued] = buildAttempts(normalized, NOW);
  const waiting = persistedAttempt(queued);
  const waitingRequest = { ...coordinatorRequest(normalized, singleStreams, { coverageStatus: 'waiting_stt', availableRoles: [], missingRoles: ['current'], failedLogicalJobKeys: [] }), status: 'waiting_stt' };
  const timeoutPlan = classifyAttemptFailure({ deadlineExceeded: true }, waiting.attempt, '2026-08-22T00:30:00.000Z', waitingRequest.createdAt, waitingRequest.requestType);
  assert.equal(timeoutPlan.status, 'timed_out');
  const timedOut = { ...waiting, status: timeoutPlan.status, errorCode: timeoutPlan.errorCode, nextRetryAtIso: timeoutPlan.nextRetryAtIso };
  const timeout = aggregateLogicalJobs(waitingRequest, [timedOut]);
  assert.equal(timeout.coverageStatus, 'partial');
  assert.notEqual(timeout.coverageStatus, 'complete');
  const ready = coordinatorRequest(normalized, singleStreams, timeout);
  const preflight = preflightAI([ready], [timedOut], singlePlan.requestKey, 'exec-single', '2026-08-22T00:30:00.000Z');
  assert.equal(preflight.action, 'ai');
  const timeoutInput = buildSummaryInput(preflight, preflight);
  aiSummary.validateInput(timeoutInput);
  assert.deepEqual(timeoutInput.missingRoles, ['current']);
  assert.equal(timeoutInput.streams[0].transcript.outcome, 'timed_out');
  const report = renderSummaryMarkdown({ report: { summary: 'Technical evidence only' } }, timeoutInput.coverageStatus, timeoutInput.streams);
  assert.match(report, /current \/ 9001：STT 等待逾時，未取得轉錄資訊/);
  const empty = aggregateLogicalJobs({ ...coordinatorRequest(normalized, singleStreams, { coverageStatus: 'waiting_stt', availableRoles: [], missingRoles: ['current'], failedLogicalJobKeys: [] }), status: 'waiting_stt' }, [
    { ...waiting, status: 'completed', consumedAtIso: '2026-08-22T02:10:00.000Z', errorCode: 'callback_empty_transcription' },
  ]);
  assert.equal(empty.coverageStatus, 'complete');
  assert.equal(empty.streams[0].transcript.outcome, 'empty');
  assert.equal(empty.streams[0].dialogue, '');
});

test('maps only the single-stream request to the child full-inference expression', () => {
  const workflow = JSON.parse(fs.readFileSync(path.join(root, 'workflows/ai_summary_v3_AISummaryV3A0001/workflow.json'), 'utf8'));
  const expression = workflow.nodes.find(({ name }) => name === 'Call AI SUMMARY Inference SubWF')
    .parameters.workflowInputs.value.analysisMode.slice(3, -2);
  assert.equal(vm.runInNewContext(expression, { $json: { input: { requestType: 'single_stream_summary' } } }), 'single_stream_full');
  assert.equal(vm.runInNewContext(expression, { $json: { input: { requestType: 'suspect_summary' } } }), '');
});
