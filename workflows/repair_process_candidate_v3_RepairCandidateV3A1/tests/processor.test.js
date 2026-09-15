const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const processorDir = path.resolve(__dirname, '..');
const schedulerPath = 'workflows/automation_retry_and_repair_v3_AutoRepairV3A001/workflow.json';
const processor = JSON.parse(fs.readFileSync(path.join(processorDir, 'workflow.json'), 'utf8'));
const original = JSON.parse(execFileSync('git', ['show', `HEAD:${schedulerPath}`], {
  cwd: path.resolve(processorDir, '../..'),
  encoding: 'utf8',
}));
const {
  aggregateLogicalJobs,
  classifyAttemptFailure,
  planCallbackDeadline,
} = require('../nodes/Plan_Repairs/jsCode');
const schema = require('../../automation_provision_state_v3_AutomationProvV3A1/nodes/State_Schema/schema.json');
const { verifyRetryDeadlineExhausted } = require('../nodes/Verify_Retry_Deadline_Exhausted/jsCode');

function tableRow(table, overrides) {
  return {
    id: overrides.id,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...Object.fromEntries(schema[table].map(({ name, type }) => [name, type === 'number' ? 0 : type === 'boolean' ? false : ''])),
    ...overrides,
  };
}

function targets(workflow, name) {
  return Object.values(workflow.connections[name] || {})
    .flatMap((outputs) => outputs.flatMap((branch) => branch.map(({ node }) => node)));
}

function reachable(workflow, start) {
  const result = new Set();
  const pending = [start];
  while (pending.length) {
    const name = pending.pop();
    if (result.has(name)) continue;
    result.add(name);
    for (const target of targets(workflow, name)) pending.push(target);
  }
  return result;
}

test('processor mechanically retains the complete original retry safety subgraph', () => {
  const originalNames = reachable(original, 'Read Retry Same Attempt');
  originalNames.delete('Repair Side Effect Sink');
  const processorNames = new Set(processor.nodes.map(({ name }) => name));
  for (const name of originalNames) assert.ok(processorNames.has(name), `missing original retry node ${name}`);
  assert.equal(processorNames.has('Repair Side Effect Sink'), false);
  assert.equal(processor.nodes.filter(({ name }) => originalNames.has(name)).length, originalNames.size);
});

test('processor preserves every original retry connection between retained nodes', () => {
  const retained = reachable(original, 'Read Retry Same Attempt');
  retained.delete('Repair Side Effect Sink');
  for (const source of retained) {
    const expected = targets(original, source).filter((target) => retained.has(target));
    const actual = targets(processor, source);
    for (const target of expected) {
      if (source === 'Plan Exact Retry Claim' && target === 'Carry Retry Claim Plan') {
        assert.deepEqual(actual, ['Retry Claim Is Actionable']);
        assert.ok(targets(processor, 'Retry Claim Is Actionable').includes(target));
      } else if (source === 'Re-read Next Retry Insert Rows' && target === 'Merge Insert Retry Plan And Reread') {
        assert.deepEqual(actual, ['Canonicalize Inserted Next Retry Exact']);
        assert.ok(targets(processor, 'Canonicalize Inserted Next Retry Exact').includes(target));
      } else {
        assert.ok(actual.includes(target), `${source} -> ${target} was not preserved`);
      }
    }
  }
});

test('processor has the typed candidate contract, self-contained helper, and explicit terminal returns', () => {
  const start = processor.nodes.find(({ name }) => name === 'Start');
  assert.equal(start.type, 'n8n-nodes-base.executeWorkflowTrigger');
  assert.equal(start.typeVersion, 1.2);
  assert.deepEqual(start.parameters.workflowInputs.values, [
    { name: 'repairClass', type: 'string' },
    { name: 'candidateKey', type: 'string' },
    { name: 'scanTimeIso', type: 'string' },
  ]);
  const validator = processor.nodes.find(({ name }) => name === 'Validate Retry Candidate Input');
  assert.match(validator.parameters.jsCode, /retry_materialization/);
  assert.match(validator.parameters.jsCode, /presentation_lease/);
  assert.match(validator.parameters.jsCode, /attemptKey: candidateKey/);
  assert.match(validator.parameters.jsCode, /nowIso: scanTimeIso/);
  assert.equal(fs.existsSync(path.join(processorDir, 'nodes/Plan_Repairs/jsCode.js')), true);
  for (const name of ['Return Repaired', 'Return Noop', 'Return Manual Review']) {
    assert.ok(processor.nodes.some((node) => node.name === name), `missing ${name}`);
  }
  assert.equal(processor.nodes.find(({ name }) => name === 'Dispatch Canonical Next Retry Attempt').typeVersion, 1.3);
  assert.deepEqual(targets(processor, 'Validate Retry Candidate Input'), ['Route Candidate Repair Class']);
  assert.deepEqual(targets(processor, 'Route Candidate Repair Class'), [
    'Read Retry Same Attempt', 'Merge Retry Claim Attempt And Summary',
    'Re-read Presentation Repair Attempt', 'Merge Presentation Attempt And Summary',
  ]);
  assert.equal(processor.nodes.find(({ name }) => name === 'Merge Retry Claim Attempt And Summary').parameters.numberInputs, 3);
  assert.equal(processor.connections['Route Candidate Repair Class'].main[0].find(({ node }) => node === 'Merge Retry Claim Attempt And Summary').index, 2);
  assert.deepEqual(targets(processor, 'Plan Exact Retry Claim'), ['Retry Claim Is Actionable']);
  assert.deepEqual(targets(processor, 'Retry Claim Is Actionable'), ['Carry Retry Claim Plan', 'Retry Deadline Is Exhausted']);
  assert.deepEqual(targets(processor, 'Retry Deadline Is Exhausted'), ['Expire Retry Deadline Exact', 'Return Noop']);
  assert.deepEqual(targets(processor, 'Expire Retry Deadline Exact'), ['Limit Retry Deadline Patch']);
  assert.deepEqual(targets(processor, 'Limit Retry Deadline Patch'), ['Re-read Retry Deadline State']);
  assert.deepEqual(targets(processor, 'Re-read Retry Deadline State'), ['Verify Retry Deadline Exhausted']);
  const expiry = processor.nodes.find(({ name }) => name === 'Expire Retry Deadline Exact');
  assert.equal(expiry.parameters.operation, 'update');
  assert.equal(expiry.parameters.matchType, 'allConditions');
  assert.equal(expiry.alwaysOutputData, true);
  assert.deepEqual(expiry.parameters.columns.value, {
    status: 'timed_out',
    errorCode: 'stt_retry_deadline_exceeded',
    nextRetryAtIso: '',
    retryLeaseOwner: '',
    retryLeaseUntilIso: '',
    updatedAtIso: '={{ $now.toUTC().toISO() }}',
  });
  assert.deepEqual(processor.nodes.find(({ name }) => name === 'Claim Retry Materialization Exact').parameters.columns.schema, []);
  for (const name of ['Return Repaired', 'Return Noop', 'Return Manual Review']) {
    assert.match(processor.nodes.find((node) => node.name === name).parameters.jsCode, /result:/);
    assert.match(processor.nodes.find((node) => node.name === name).parameters.jsCode, /nextAttemptKey:/);
  }
});

test('processor canonicalizes a newly inserted retry row with exact CAS before verification', () => {
  const node = processor.nodes.find(({ name }) => name === 'Canonicalize Inserted Next Retry Exact');
  assert.ok(node);
  assert.equal(node.type, 'n8n-nodes-base.dataTable');
  assert.equal(node.parameters.operation, 'update');
  assert.equal(node.alwaysOutputData, true);
  const filters = Object.fromEntries(node.parameters.filters.conditions.map(({ keyName, keyValue }) => [keyName, keyValue]));
  assert.deepEqual(filters, {
    id: '={{ $json.id }}',
    attemptKey: '={{ $json.attemptKey }}',
    status: 'queued',
    reconciliationStatus: 'pending',
    canonicalRowID: '',
    updatedAtIso: '={{ $json.updatedAtIso }}',
  });
  assert.deepEqual(node.parameters.columns.value, {
    reconciliationStatus: 'canonical',
    canonicalRowID: '={{ String($json.id) }}',
    updatedAtIso: '={{ $now.toUTC().toISO() }}',
  });
  assert.deepEqual(targets(processor, 'Re-read Next Retry Insert Rows'), ['Canonicalize Inserted Next Retry Exact']);
  assert.deepEqual(targets(processor, 'Canonicalize Inserted Next Retry Exact'), ['Merge Insert Retry Plan And Reread']);
});

test('processor isolates the complete presentation lease subgraph with explicit noop and repaired returns', () => {
  const names = [
    'Re-read Presentation Repair Attempt', 'Read Presentation Summary Rows',
    'Merge Presentation Attempt And Summary', 'Tag Plan Presentation Repair',
    'Plan Presentation Repair', 'Patch Presentation Repair', 'Limit Presentation Repair Patch',
    'Re-read Presentation Repair Patch', 'Merge Presentation Plan And Reread',
    'Tag Verify Presentation Repair', 'Verify Presentation Repair', 'Run Presentation Owner Repair',
  ];
  for (const name of names) assert.ok(processor.nodes.some((node) => node.name === name), `missing ${name}`);
  assert.deepEqual(new Set(targets(processor, 'Re-read Presentation Repair Attempt')), new Set(['Read Presentation Summary Rows', 'Merge Presentation Attempt And Summary']));
  assert.equal(processor.connections['Re-read Presentation Repair Attempt'].main[0].find(({ node }) => node === 'Merge Presentation Attempt And Summary').index, 0);
  assert.equal(processor.connections['Read Presentation Summary Rows'].main[0][0].index, 1);
  assert.equal(processor.nodes.find(({ name }) => name === 'Merge Presentation Attempt And Summary').parameters.numberInputs, 3);
  assert.equal(processor.connections['Route Candidate Repair Class'].main[1].find(({ node }) => node === 'Merge Presentation Attempt And Summary').index, 2);
  assert.deepEqual(targets(processor, 'Plan Presentation Repair'), ['Presentation Repair Is Actionable']);
  assert.deepEqual(targets(processor, 'Presentation Repair Is Actionable'), ['Carry Presentation Repair Plan', 'Return Noop']);
  assert.deepEqual(new Set(targets(processor, 'Carry Presentation Repair Plan')), new Set(['Patch Presentation Repair', 'Merge Presentation Plan And Reread']));
  assert.equal(processor.connections['Carry Presentation Repair Plan'].main[0].find(({ node }) => node === 'Merge Presentation Plan And Reread').index, 0);
  assert.equal(processor.connections['Re-read Presentation Repair Patch'].main[0][0].index, 1);
  assert.deepEqual(targets(processor, 'Verify Presentation Repair'), ['Run Presentation Owner Repair']);
  assert.deepEqual(targets(processor, 'Verify Retry Deadline Exhausted'), ['Run Presentation Owner Repair']);
  assert.deepEqual(targets(processor, 'Run Presentation Owner Repair'), ['Return Repaired']);
  const presentationPatch = processor.nodes.find(({ name }) => name === 'Patch Presentation Repair');
  assert.equal(Object.fromEntries(presentationPatch.parameters.filters.conditions.map(({ keyName, keyValue }) => [keyName, keyValue])).status, '={{ $json.filters.status }}');
  const retryVerifier = processor.nodes.find(({ name }) => name === 'Verify Retry Deadline Exhausted');
  const retryCode = fs.readFileSync(path.join(processorDir, retryVerifier.parameters.jsCode.replace('__EXTERNAL_FILE__://', '')), 'utf8');
  assert.match(retryCode, /presentationStatus !== 'pending'/);
  assert.match(retryCode, /attemptKey: row\.attemptKey/);
  const helper = fs.readFileSync(path.join(processorDir, 'nodes/Plan_Repairs/jsCode.js'), 'utf8');
  assert.match(helper, /Retry claim requires exactly one candidate carrier/);
  assert.match(helper, /Presentation repair requires exactly one candidate carrier/);
  assert.match(helper, /oldAttempt\.requestType === 'standalone_stt' \? undefined : canonicalRequest\(requests, oldAttempt\.requestKey\)/);
  assert.match(helper, /planRetryMaterializationClaim\(oldAttempt, candidate\.nowIso, owner, request\)/);
  assert.match(helper, /planPresentationRepair\(attReconcile\.canonical, candidate\.nowIso\)/);
  for (const name of ['Return Repaired', 'Return Noop']) {
    const code = processor.nodes.find((node) => node.name === name).parameters.jsCode;
    assert.match(code, /repairClass: input\.repairClass/);
    assert.match(code, /nextAttemptKey:/);
  }
});

test('retry-deadline notification requires an exact fresh canonical readback', () => {
  const plan = { filters: { id: 1, attemptKey: 'job:9' } };
  const row = { id: 1, attemptKey: 'job:9', status: 'timed_out', errorCode: 'stt_retry_deadline_exceeded',
    retryLeaseOwner: '', retryLeaseUntilIso: '', nextRetryAtIso: '', reconciliationStatus: 'canonical',
    canonicalRowID: '1', presentationStatus: 'pending' };
  assert.equal(verifyRetryDeadlineExhausted([row], plan).attemptKey, 'job:9');
  for (const rows of [[], [{}], [row, { ...row, id: 2, canonicalRowID: '2' }],
    [{ ...row, status: 'retry_pending' }], [{ ...row, id: 2, canonicalRowID: '2' }],
    [{ ...row, attemptKey: 'different:9' }], [{ ...row, presentationStatus: 'completed' }]]) {
    assert.throws(() => verifyRetryDeadlineExhausted(rows, plan), /transition/);
  }
  const reread = processor.nodes.find(({ name }) => name === 'Re-read Retry Deadline State');
  assert.equal(reread.parameters.returnAll, true);
  assert.equal(reread.alwaysOutputData, true);
  assert.match(reread.parameters.filters.conditions[0].keyValue, /Retry Deadline Is Exhausted/);
});

test('processor has no structurally unreachable nodes', () => {
  const reached = reachable(processor, 'Start');
  const names = processor.nodes.map(({ name }) => name);
  assert.deepEqual(new Set(names), reached);
});

test('processor aggregate treats timeout as partial and hard failure as all_failed', () => {
  const requestKey = 'summary:req-001';
  const logicalJobKey = `${requestKey}:current:9001:fromStart`;
  const streamContext = { liveStreamID: '9001', eligible: true, beginTime: 1787360400, endTime: 1787364000 };
  const request = tableRow('summary_requests_v3', {
    id: 1,
    requestKey,
    requestType: 'suspect',
    channel: 'C0A4JJJKJMD',
    threadTS: '1234567890.123456',
    status: 'waiting_stt',
    orderedStreamsJson: JSON.stringify([{ role: 'current', liveStreamID: '9001', mode: 'fromStart', durationMinutes: 5, streamContext }]),
    expectedLogicalJobKeysJson: JSON.stringify([logicalJobKey]),
    existingDialoguesJson: '{}',
    reconciliationStatus: 'canonical',
    canonicalRowID: '1',
  });
  const baseAttempt = tableRow('stt_jobs_v3', {
    id: 10,
    logicalJobKey,
    requestKey,
    requestType: 'suspect',
    role: 'current',
    streamID: '9001',
    mode: 'fromStart',
    durationMinutes: 5,
    streamContextJson: JSON.stringify(streamContext),
    channel: 'C0A4JJJKJMD',
    threadTS: '1787364000.000001',
    processingMessageTS: '1787364001.000002',
    presentationStatus: 'pending',
    createdAtIso: '2026-08-24T00:00:00.000Z',
    updatedAtIso: '2026-08-24T00:00:00.000Z',
    reconciliationStatus: 'canonical',
  });
  const attempts = [
    {
      ...baseAttempt,
      id: 10,
      attemptKey: `${logicalJobKey}:1`,
      attempt: 1,
      status: 'retry_materialized',
      manualReviewResolution: `retry_created:${logicalJobKey}:2`,
      canonicalRowID: '10',
    },
    {
      ...baseAttempt,
      id: 11,
      attemptKey: `${logicalJobKey}:2`,
      attempt: 2,
      status: 'timed_out',
      manualReviewResolution: '',
      canonicalRowID: '11',
    },
  ];
  const result = aggregateLogicalJobs(request, attempts);

  assert.equal(result.action, 'ready');
  assert.equal(result.coverageStatus, 'partial');
  assert.deepEqual(result.failedLogicalJobKeys, [logicalJobKey]);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].dialogue, '');

  const hardFailure = aggregateLogicalJobs(request, attempts.map((row) => (
    row.status === 'timed_out' ? { ...row, status: 'failed' } : row
  )));
  assert.equal(hardFailure.action, 'all_failed');
  assert.equal(hardFailure.coverageStatus, 'all_failed');
});

test('processor aggregate preserves unavailable paired stream without expecting an attempt', () => {
  const requestKey = 'summary:req-002';
  const logicalJobKey = `${requestKey}:current:9001:fromStart`;
  const currentContext = { liveStreamID: '9001', eligible: true, beginTime: 1787360400, endTime: 1787364000 };
  const unavailableContext = { liveStreamID: '9002', eligible: false, profile: 'stt', source: 'livestream_v2' };
  const request = tableRow('summary_requests_v3', {
    id: 2,
    requestKey,
    requestType: 'suspect',
    channel: 'C0A4JJJKJMD',
    threadTS: '1234567890.123456',
    status: 'waiting_stt',
    orderedStreamsJson: JSON.stringify([
      { role: 'current', liveStreamID: '9001', mode: 'fromStart', durationMinutes: 5, streamContext: currentContext },
      { role: 'suspect', liveStreamID: '9002', mode: 'fromStart', durationMinutes: 5, streamContext: unavailableContext, sttEligible: false },
    ]),
    expectedLogicalJobKeysJson: JSON.stringify([logicalJobKey]),
    existingDialoguesJson: '{}',
    reconciliationStatus: 'canonical',
    canonicalRowID: '2',
  });
  const completed = tableRow('stt_jobs_v3', {
    id: 20,
    attemptKey: `${logicalJobKey}:1`,
    logicalJobKey,
    requestKey,
    requestType: 'suspect',
    attempt: 1,
    role: 'current',
    streamID: '9001',
    mode: 'fromStart',
    durationMinutes: 5,
    streamContextJson: JSON.stringify(currentContext),
    status: 'completed',
    channel: 'C0A4JJJKJMD',
    threadTS: '1234567890.123456',
    processingMessageTS: '1234567891.123456',
    dialogue: 'current transcript',
    reconciliationStatus: 'canonical',
    canonicalRowID: '20',
  });

  const result = aggregateLogicalJobs(request, [completed]);

  assert.equal(result.action, 'ready');
  assert.equal(result.coverageStatus, 'partial');
  assert.deepEqual(result.availableRoles, ['current']);
  assert.deepEqual(result.missingRoles, ['suspect']);
  assert.equal(result.streams.length, 2);
  assert.equal(result.streams[0].dialogue, 'current transcript');
  assert.equal(result.streams[1].dialogue, '');
});

test('single-stream summary retries service failures and terminates callbacks at thirty minutes', () => {
  const requestKey = 'summary:req-single';
  const logicalJobKey = `${requestKey}:current:9001:fromStart`;
  const streamContext = { liveStreamID: '9001', eligible: true, beginTime: 1787360400, endTime: 1787371200 };
  const request = tableRow('summary_requests_v3', {
    id: 31,
    requestKey,
    requestType: 'single_stream_summary',
    channel: 'C0A4JJJKJMD',
    threadTS: '1234567890.123456',
    status: 'waiting_stt',
    orderedStreamsJson: JSON.stringify([{ role: 'current', liveStreamID: '9001', mode: 'fromStart', durationMinutes: 180, streamContext }]),
    expectedLogicalJobKeysJson: JSON.stringify([logicalJobKey]),
    existingDialoguesJson: '{}',
    reconciliationStatus: 'canonical',
    canonicalRowID: '31',
  });
  const waiting = tableRow('stt_jobs_v3', {
    id: 32,
    attemptKey: `${logicalJobKey}:1`,
    logicalJobKey,
    requestKey,
    requestType: 'single_stream_summary',
    attempt: 1,
    role: 'current',
    streamID: '9001',
    mode: 'fromStart',
    durationMinutes: 180,
    streamContextJson: JSON.stringify(streamContext),
    status: 'waiting_callback',
    callbackDeadlineAtIso: '2026-08-24T00:01:00.000Z',
    channel: 'C0A4JJJKJMD',
    threadTS: '1234567890.123456',
    processingMessageTS: '1234567891.123456',
    presentationStatus: 'pending',
    reconciliationStatus: 'canonical',
    canonicalRowID: '32',
  });

  const serviceFailure = classifyAttemptFailure(
    { retryableServiceError: true }, 1, '2026-08-24T00:00:30.000Z', request.createdAt, request.requestType,
  );
  assert.equal(serviceFailure.status, 'retry_pending');
  assert.equal(serviceFailure.nextRetryAtIso, '2026-08-24T00:01:00.000Z');

  const deadline = planCallbackDeadline(waiting, '2026-08-24T00:30:00.000Z', request);
  assert.equal(deadline.status, 'timed_out');
  assert.equal(deadline.errorCode, 'callback_deadline_exceeded');
  assert.equal(deadline.nextRetryAtIso, '');
  assert.equal(deadline.desired.status, 'timed_out');
  assert.equal(Object.hasOwn(deadline.desired, 'nextAttemptKey'), false);
});
