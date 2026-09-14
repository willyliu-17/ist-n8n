const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const { buildWorkflow } = require('../../../scripts/utils');
const { buildFailureStatus } = require('../nodes/Build_Failure_Status/jsCode');
const { verifyFailureStatusUpdate } = require('../nodes/Verify_Failure_Status_Update/jsCode');
const { sanitizeStageError } = require('../nodes/Sanitize_Stage_Error/jsCode');
const { failurePlan } = require('../nodes/Validate_Resolved_Input/jsCode');
const root = path.resolve(__dirname, '..');
const workflow = buildWorkflow(root);
const node = (name) => workflow.nodes.find((item) => item.name === name);

test('scope mismatch is persisted before updating the original Slack status on every bounded attempt', () => {
  const row = { id: 1, requestKey: 'request', canonicalRowID: '1', summaryAttempt: 0, channel: 'C09F0SYG57D', summaryMessageTS: '1789351293.333129' };
  const input = { requestKey: 'request' };
  const failure = sanitizeStageError({ kind: 'carrier', input, row, nextStage: 'inference', error: { message: 'summary_analysis_scope_mismatch [line 24]' } });
  assert.equal(failure.errorCode, 'summary_analysis_scope_mismatch');
  for (const attempt of [0, 1, 2]) {
    const plan = failurePlan({ ...row, summaryAttempt: attempt }, 'inference', failure.errorCode, new Date('2026-09-14T04:00:00Z'));
    const persisted = { ...row, ...plan.values };
    const status = buildFailureStatus(persisted);
    assert.match(status.statusText, /Analysis scope validation failed.*No report was published/);
    assert.match(status.statusText, attempt === 2 ? /failed after the retry limit/ : /retry shortly/);
    assert.equal(status.summaryMessageTS, row.summaryMessageTS);
    assert.deepEqual(verifyFailureStatusUpdate({ ok: true, channel: row.channel, message_timestamp: row.summaryMessageTS }, status), status);
  }
});

test('Slack failure does not silently return success or loop back into inference and upload', () => {
  const targets = (name) => workflow.connections[name]?.main?.[0]?.map((edge) => edge.node) || [];
  assert.deepEqual(targets('Verify Failure'), ['Build Failure Status']);
  assert.deepEqual(targets('Build Failure Status'), ['Update Summary Status Failure']);
  assert.deepEqual(targets('Update Summary Status Failure'), ['Verify Failure Status Update']);
  assert.deepEqual(targets('Verify Failure Status Update'), ['Return Result']);
  const update = node('Update Summary Status Failure');
  assert.equal(update.onError, 'stopWorkflow');
  assert.equal(update.alwaysOutputData, true);
  assert.equal(update.retryOnFail, true);
  assert.equal(update.maxTries, 3);
  const status = { channel: 'C09F0SYG57D', summaryMessageTS: '1789351293.333129', status: 'failed' };
  for (const response of [{}, { ok: false, error: 'message_not_found' }, { ok: true, channel: status.channel, ts: '1789351293.999999' }, { ok: true, channel: 'wrong', ts: status.summaryMessageTS }]) {
    assert.throws(() => verifyFailureStatusUpdate(response, status), /summary_failure_status_update_failed/);
  }
  assert.throws(() => buildFailureStatus({ status: 'failed' }), /summary_status_message_missing/);
});

test('caller mapping preserves single and comparison scope including missing dialogue roles', () => {
  const mapping = node('Call AI SUMMARY Inference SubWF').parameters.workflowInputs.value;
  for (const requestType of ['single_stream_summary', 'suspect_summary']) {
    const streams = requestType === 'single_stream_summary' ? [{ liveStreamID: '215321109', role: 'current' }]
      : [{ liveStreamID: '215320756', role: 'previous' }, { liveStreamID: '215321109', role: 'current' }];
    const input = { requestType, streams, missingRoles: [streams[0].role], coverageStatus: 'partial' };
    const evaluate = (expression) => JSON.parse(JSON.stringify(vm.runInNewContext(`(${expression.slice(3, -2)})`, { $json: { input } })));
    const scope = evaluate(mapping.analysisScope);
    assert.deepEqual(scope.requestedStreams, streams);
    assert.deepEqual(scope.missingDialogueRoles, input.missingRoles);
    assert.equal(scope.coverageStatus, 'partial');
    assert.equal(evaluate(mapping.analysisMode), requestType === 'single_stream_summary' ? 'single_stream_full' : '');
  }
});
