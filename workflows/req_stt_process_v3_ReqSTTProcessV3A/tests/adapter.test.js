const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowDir = path.resolve(__dirname, '..');
const workflowPath = path.join(workflowDir, 'workflow.json');
const normalizePath = path.join(workflowDir, 'nodes', 'Normalize_Standalone_Input', 'jsCode.js');
const buildPath = path.join(workflowDir, 'nodes', 'Build_Standalone_Attempt', 'jsCode.js');
const reconcilePath = path.join(workflowDir, 'nodes', 'Reconcile_Canonical', 'jsCode.js');
const schemaPath = path.resolve(workflowDir, '..', 'automation_provision_state_v3_AutomationProvV3A1', 'nodes', 'State_Schema', 'schema.json');
const {
  MODE_ALIASES,
  RESOLVER_CONTEXT_FIELDS,
  buildLookupWindow,
  buildPreviousFallbackWindow,
  extendPairingWindow,
  normalizeStandaloneInput,
  planDiscoveryWindow,
  requireEligibleResolverContext,
} = require(normalizePath);
const { ATTEMPT_FIELDS, buildAttempt } = require(buildPath);
const { CHECKPOINT_FIELDS, planCanonicalReconciliation, verifyFrozenConflict } = require(reconcilePath);

const NOW = '2026-08-22T00:00:00.000Z';
const THREAD_TS = '1787364000.000001';
const CHANNEL = 'C0A4JJJKJMD';

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

function incomingSources(workflow, target) {
  const sources = [];
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    for (const output of outputs.main || []) {
      if ((output || []).some(({ node }) => node === target)) sources.push(source);
    }
  }
  return sources.sort();
}

function reachableNodes(workflow, source) {
  const seen = new Set();
  const pending = [source];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const output of workflow.connections[current]?.main || []) {
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

function resolverContext(overrides = {}) {
  const values = {
    inputIndex: 0,
    status: 'found',
    source: 'livestream_v2',
    profile: 'stt',
    liveStreamID: '9001',
    userID: 'user-1',
    openID: 'open-1',
    beginTime: 1787360400,
    endTime: 1787364000,
    duration: 3600,
    region: 'TW',
    appVersion: '3.4.5',
    deviceType: 'ios',
    publishSec: null,
    vliverModel: 0,
    closeBy: 1,
    streamMode: 0,
    isOBS: false,
    caption: '',
    deviceModel: 'iPhone',
    osVersion: '18',
    publicIP: '192.0.2.1',
    ipRegion: 'TW',
    missingFields: [],
    eligible: true,
    ...overrides,
  };
  return Object.fromEntries(RESOLVER_CONTEXT_FIELDS.map((field) => [field, values[field]]));
}

function normalizedInput(overrides = {}) {
  return normalizeStandaloneInput({
    streamID: '9001',
    mode: 'first',
    mins: 5,
    date: '',
    channel: CHANNEL,
    target_thread_ts: THREAD_TS,
    ...overrides,
  }, '2026-08-22T04:00:00+08:00');
}

function attemptRow(overrides = {}) {
  return {
    ...buildAttempt(normalizedInput(), resolverContext(), { message: { ts: '1787364001.000002' } }, NOW),
    id: 'row-a',
    createdAt: NOW,
    updatedAt: NOW,
    reconciliationStatus: 'canonical',
    canonicalRowID: 'row-a',
    ...overrides,
  };
}

test('declares exactly the six typed command inputs and no streamContext', () => {
  const workflow = readWorkflow();
  const values = nodeByName(workflow, 'Start').parameters.workflowInputs.values;
  assert.deepEqual(values, [
    { name: 'streamID', type: 'string' },
    { name: 'mode', type: 'string' },
    { name: 'mins', type: 'number' },
    { name: 'date', type: 'string' },
    { name: 'channel', type: 'string' },
    { name: 'target_thread_ts', type: 'string' },
  ]);
  assert.equal(nodeByName(workflow, 'Start').parameters.inputSource, 'workflowInputs');
});

test('maps only the four accepted aliases to canonical modes', () => {
  assert.deepEqual(MODE_ALIASES, {
    first: 'fromStart', last: 'fromEnd', fromStart: 'fromStart', fromEnd: 'fromEnd',
  });
  for (const [mode, expected] of Object.entries(MODE_ALIASES)) {
    assert.equal(normalizedInput({ mode }).mode, expected);
  }
  for (const mode of ['', 'FIRST', 'start', 'from_start', null, undefined]) {
    assert.throws(() => normalizedInput({ mode }), /mode must/i);
  }
});

test('strictly validates streamID, C0 channel, Slack timestamp, mins, and date', () => {
  for (const streamID of ['', ' 9001', '-1', '1e3', 'a1', '1'.repeat(21), 9001]) {
    assert.throws(() => normalizedInput({ streamID }), /streamID/i, String(streamID));
  }
  for (const channel of ['', 'C09F0SYG57D', '#channel', undefined]) {
    assert.throws(() => normalizedInput({ channel }), /channel/i, String(channel));
  }
  for (const target_thread_ts of ['', '1787364000', '1787364000.1', 'abc.000001', 1787364000]) {
    assert.throws(() => normalizedInput({ target_thread_ts }), /Slack timestamp/i, String(target_thread_ts));
  }
  for (const mins of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
    assert.throws(() => normalizedInput({ mins }), /mins/i, String(mins));
  }
  for (const date of ['2025-02-29', '2025-13-01', '2025-01-32', '01-02-2025', 20250102]) {
    assert.throws(() => normalizedInput({ date }), /date/i, String(date));
  }
  assert.equal(normalizedInput({ date: '2024-02-29' }).date, '2024-02-29');
});

test('builds exact default and explicit Asia/Taipei lookup windows', () => {
  assert.deepEqual(buildLookupWindow({ nowIso: '2026-08-22T04:00:00+08:00' }), {
    start: '2026-07-23T04:00:00+08:00',
    end: '2026-08-22T04:00:00+08:00',
  });
  assert.deepEqual(buildLookupWindow({ date: '2025-01-02' }), {
    start: '2025-01-02T04:00:00+08:00',
    end: '2025-01-03T04:00:00+08:00',
  });
  assert.deepEqual(buildLookupWindow({ date: '2024-12-31' }), {
    start: '2024-12-31T04:00:00+08:00',
    end: '2025-01-01T04:00:00+08:00',
  });
});

test('extends pairing only beyond base bounds and caps each side at six hours', () => {
  const base = { start: '2025-01-02T04:00:00+08:00', end: '2025-01-03T04:00:00+08:00' };
  assert.deepEqual(extendPairingWindow(base, {
    previousBegin: '2025-01-02T05:00:00+08:00', currentEnd: '2025-01-03T03:00:00+08:00',
  }), base);
  assert.deepEqual(extendPairingWindow(base, {
    previousBegin: '2025-01-01T23:30:00+08:00', currentEnd: '2025-01-03T08:30:00+08:00',
  }), { start: '2025-01-01T23:30:00+08:00', end: '2025-01-03T08:30:00+08:00' });
  const capped = extendPairingWindow(base, {
    previousBegin: '2025-01-01T18:00:00+08:00', currentEnd: '2025-01-03T14:00:00+08:00',
  });
  assert.deepEqual(capped, { start: '2025-01-01T22:00:00+08:00', end: '2025-01-03T10:00:00+08:00' });
  assert.equal(Date.parse(capped.end) - Date.parse(capped.start), 36 * 60 * 60 * 1000);
});

test('keeps previousFallbackWindow separate and bounded to at most 30 days', () => {
  const base = buildLookupWindow({ date: '2025-01-02' });
  assert.deepEqual(buildPreviousFallbackWindow(base), {
    start: '2024-12-03T04:00:00+08:00',
    end: '2025-01-02T04:00:00+08:00',
  });
  assert.deepEqual(base, {
    start: '2025-01-02T04:00:00+08:00', end: '2025-01-03T04:00:00+08:00',
  });
  assert.throws(() => buildPreviousFallbackWindow(base, 31), /1\.\.30/);
  assert.doesNotMatch(fs.readFileSync(normalizePath, 'utf8'), /narrow extension/i);
});

test('uses base discovery first and requests fallback only for a valid unusable result', () => {
  const input = normalizedInput({ date: '2025-01-02' });
  const notFound = resolverContext({
    status: 'not_found', eligible: false, beginTime: null, endTime: null,
    userID: null, openID: null, duration: null, vliverModel: null,
  });
  assert.deepEqual(planDiscoveryWindow([notFound], input, 'base'), {
    streamID: '9001',
    baseLookupWindow: input.lookupWindow,
    previousFallbackWindow: input.previousFallbackWindow,
    finalLookupWindow: null,
    discoverySource: 'base',
    needsFallback: true,
  });
  const partialWithoutBoundaries = resolverContext({
    status: 'partial', eligible: false, beginTime: null, endTime: null,
  });
  assert.equal(planDiscoveryWindow([partialWithoutBoundaries], input, 'base').needsFallback, true);
  assert.throws(() => planDiscoveryWindow([], input, 'base'), /exactly one/i);
  assert.throws(() => planDiscoveryWindow([notFound, notFound], input, 'base'), /exactly one/i);
  assert.throws(() => planDiscoveryWindow([resolverContext({ profile: 'core' })], input, 'base'), /ownership/i);
  assert.throws(() => planDiscoveryWindow([resolverContext({ status: 'unknown' })], input, 'base'), /status/i);
  assert.throws(() => planDiscoveryWindow([resolverContext({ status: 'not_found', eligible: false })], input, 'base'), /malformed/i);
  assert.throws(() => planDiscoveryWindow([resolverContext({ status: 'found', beginTime: null })], input, 'base'), /found context/i);
});

test('turns discovery epoch boundaries into the exact bounded explicit final window', () => {
  const input = normalizedInput({ date: '2025-01-02' });
  const discovery = resolverContext({
    status: 'partial',
    eligible: false,
    openID: null,
    beginTime: Date.parse('2025-01-01T23:30:00+08:00') / 1000,
    endTime: Date.parse('2025-01-03T08:30:00+08:00') / 1000,
  });
  const plan = planDiscoveryWindow([discovery], input, 'fallback');
  assert.equal(plan.needsFallback, false);
  assert.equal(plan.discoverySource, 'fallback');
  assert.deepEqual(plan.finalLookupWindow, {
    start: '2025-01-01T23:30:00+08:00',
    end: '2025-01-03T08:30:00+08:00',
  });
  assert.notDeepEqual(plan.finalLookupWindow, input.previousFallbackWindow);
});

test('caps fallback discovery at the final resolver gate instead of widening to fallback', () => {
  const input = normalizedInput({ date: '2025-01-02' });
  const discovery = resolverContext({
    beginTime: Date.parse('2025-01-01T18:00:00+08:00') / 1000,
    endTime: Date.parse('2025-01-03T14:00:00+08:00') / 1000,
  });
  const plan = planDiscoveryWindow([discovery], input, 'fallback');
  assert.deepEqual(plan.finalLookupWindow, {
    start: '2025-01-01T22:00:00+08:00',
    end: '2025-01-03T10:00:00+08:00',
  });
  assert.ok(Date.parse(plan.finalLookupWindow.start) > discovery.beginTime * 1000);
  assert.ok(Date.parse(plan.finalLookupWindow.end) < discovery.endTime * 1000);
  assert.equal(Date.parse(plan.finalLookupWindow.end) - Date.parse(plan.finalLookupWindow.start), 36 * 60 * 60 * 1000);
  assert.throws(() => planDiscoveryWindow([
    resolverContext({ status: 'not_found', eligible: false, beginTime: null, endTime: null }),
  ], input, 'fallback'), /usable beginTime/i);
});

test('keeps the default final lookup at exactly 30 days and within resolver limits', () => {
  const input = normalizedInput({ date: '' });
  const plan = planDiscoveryWindow([resolverContext()], input, 'base');
  assert.deepEqual(plan.finalLookupWindow, input.lookupWindow);
  const span = Date.parse(plan.finalLookupWindow.end) - Date.parse(plan.finalLookupWindow.start);
  assert.equal(span, 30 * 24 * 60 * 60 * 1000);
  assert.ok(span <= 31 * 24 * 60 * 60 * 1000);
});

test('accepts exactly one complete eligible resolver-owned STT context', () => {
  const context = resolverContext();
  assert.deepEqual(requireEligibleResolverContext([context], '9001'), context);
  assert.deepEqual(requireEligibleResolverContext([resolverContext({ status: 'partial', caption: null })], '9001').status, 'partial');
  assert.throws(() => requireEligibleResolverContext([], '9001'), /exactly one/i);
  assert.throws(() => requireEligibleResolverContext([context, context], '9001'), /exactly one/i);
  for (const overrides of [
    { profile: 'core' }, { source: 'datamart' }, { inputIndex: 1 }, { liveStreamID: '9002' },
    { eligible: false }, { status: 'not_found' }, { openID: null }, { duration: null },
  ]) {
    assert.throws(() => requireEligibleResolverContext([resolverContext(overrides)], '9001'), /resolver|eligible|missing/i);
  }
  const missingOwnedField = resolverContext();
  delete missingOwnedField.caption;
  assert.throws(() => requireEligibleResolverContext([missingOwnedField], '9001'), /missing caption/i);
});

test('rejects dispatcher-incompatible final context before the only Slack edge', () => {
  const reviewerCase = resolverContext({
    status: 'partial', eligible: true, region: null, missingFields: ['region'],
  });
  assert.throws(() => requireEligibleResolverContext([reviewerCase], '9001'), /missing region/i);

  for (const field of ['userID', 'openID', 'region']) {
    for (const value of ['', null, 0, {}, []]) {
      assert.throws(
        () => requireEligibleResolverContext([resolverContext({ [field]: value })], '9001'),
        new RegExp(`missing ${field}|invalid ${field}`, 'i'),
        `${field}: ${String(value)}`,
      );
    }
  }
  for (const field of ['beginTime', 'endTime', 'duration', 'vliverModel']) {
    for (const value of [null, '', '1', Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      assert.throws(
        () => requireEligibleResolverContext([resolverContext({ [field]: value })], '9001'),
        new RegExp(`missing ${field}|invalid ${field}|endTime must`, 'i'),
        `${field}: ${String(value)}`,
      );
    }
  }
  for (const overrides of [
    { beginTime: 0 },
    { endTime: 0 },
    { beginTime: 10, endTime: 10 },
    { beginTime: 11, endTime: 10 },
    { duration: -1 },
    { vliverModel: -1 },
  ]) {
    assert.throws(() => requireEligibleResolverContext([resolverContext(overrides)], '9001'), /invalid|greater/i);
  }

  const workflow = readWorkflow();
  assert.deepEqual(incomingSources(workflow, 'Create Processing Message'), ['Require Eligible Stream Context']);
  assert.deepEqual(incomingSources(workflow, 'Require Eligible Stream Context'), ['Resolve Final Stream Context']);
});

test('still permits partial discovery boundaries without applying the final payload gate', () => {
  const input = normalizedInput({ date: '2025-01-02' });
  const partialDiscovery = resolverContext({
    status: 'partial', eligible: true, region: null, missingFields: ['region'],
    beginTime: Date.parse('2025-01-01T23:30:00+08:00') / 1000,
    endTime: Date.parse('2025-01-03T08:30:00+08:00') / 1000,
  });
  assert.deepEqual(planDiscoveryWindow([partialDiscovery], input, 'fallback').finalLookupWindow, {
    start: '2025-01-01T23:30:00+08:00',
    end: '2025-01-03T08:30:00+08:00',
  });
  assert.throws(() => requireEligibleResolverContext([partialDiscovery], '9001'), /missing region/i);
});

test('builds deterministic attempt 1 with the exact Task 1 primitive schema defaults', () => {
  const context = resolverContext();
  const first = buildAttempt(normalizedInput({ mode: 'first' }), context, { message: { ts: '1787364001.000002' } }, NOW);
  const last = buildAttempt(normalizedInput({ mode: 'last' }), context, { ts: '1787364001.000002' }, NOW);
  assert.equal(first.logicalJobKey, `stt:${THREAD_TS}:9001:fromStart`);
  assert.equal(first.attemptKey, `${first.logicalJobKey}:1`);
  assert.equal(first.requestKey, first.logicalJobKey);
  assert.equal(first.requestType, 'standalone_stt');
  assert.equal(first.attempt, 1);
  assert.equal(first.role, 'summary_item');
  assert.equal(first.status, 'queued');
  assert.equal(first.presentationStatus, 'pending');
  assert.equal(first.reconciliationStatus, 'pending');
  assert.equal(first.canonicalRowID, '');
  assert.equal(first.processingMessageTS, '1787364001.000002');
  assert.equal(last.mode, 'fromEnd');
  assert.equal(last.logicalJobKey, `stt:${THREAD_TS}:9001:fromEnd`);
  assert.deepEqual(Object.keys(first), ATTEMPT_FIELDS);
  const taskOneFields = JSON.parse(fs.readFileSync(schemaPath, 'utf8')).stt_jobs_v3.map(({ name }) => name);
  assert.deepEqual(ATTEMPT_FIELDS, taskOneFields);
  assert.deepEqual(JSON.parse(first.streamContextJson), context);
  for (const [field, value] of Object.entries(first)) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof value), `${field} must be primitive`);
  }
});

test('preserves an existing canonical and elects system earliest only when absent', () => {
  const existing = attemptRow({ id: 'row-z', canonicalRowID: 'row-z' });
  const later = attemptRow({
    id: 'row-a', createdAt: '2026-08-22T00:01:00.000Z', updatedAt: '2026-08-22T00:01:00.000Z',
    reconciliationStatus: 'pending', canonicalRowID: '',
  });
  const existingPlan = planCanonicalReconciliation([existing, later]);
  assert.equal(existingPlan.winnerRowID, 'row-z');
  assert.deepEqual(existingPlan.mutations.map(({ id, desiredReconciliationStatus, desiredCanonicalRowID }) => ({
    id, desiredReconciliationStatus, desiredCanonicalRowID,
  })), [{ id: 'row-a', desiredReconciliationStatus: 'duplicate', desiredCanonicalRowID: 'row-z' }]);

  const noCanonical = planCanonicalReconciliation([
    attemptRow({ id: 'row-b', reconciliationStatus: 'pending', canonicalRowID: '' }),
    attemptRow({ id: 'row-a', reconciliationStatus: 'pending', canonicalRowID: '' }),
  ]);
  assert.equal(noCanonical.winnerRowID, 'row-a');
  assert.equal(noCanonical.mutations.find(({ id }) => id === 'row-a').desiredReconciliationStatus, 'canonical');
});

test('converges clean multiple canonicals and fails closed on any checkpoint conflict', () => {
  const rows = [
    attemptRow({ id: 'row-b', canonicalRowID: 'row-b' }),
    attemptRow({ id: 'row-a', canonicalRowID: 'row-a' }),
  ];
  const clean = planCanonicalReconciliation(rows);
  assert.equal(clean.action, 'reconcile');
  assert.equal(clean.winnerRowID, 'row-a');
  assert.deepEqual(clean.mutations.map(({ id }) => id), ['row-b']);
  for (const checkpoint of CHECKPOINT_FIELDS) {
    const conflicted = rows.map((row) => ({ ...row }));
    conflicted[0][checkpoint] = `${checkpoint}-value`;
    const plan = planCanonicalReconciliation(conflicted);
    assert.equal(plan.action, 'manual_review', checkpoint);
    assert.equal(plan.reason, 'multiple_canonical_checkpoint_conflict');
    assert.equal(plan.mutations.length, 2);
    assert.ok(plan.mutations.every(({ desiredStatus }) => desiredStatus === 'manual_review'));
  }
  const frozen = rows.map((row) => ({
    ...row,
    status: 'manual_review',
    manualReviewReason: 'multiple_canonical_checkpoint_conflict',
    manualReviewAtIso: NOW,
  }));
  const expected = rows.map((row) => ({ id: row.id }));
  assert.deepEqual(verifyFrozenConflict(frozen, expected), {
    manualReview: true, reason: 'multiple_canonical_checkpoint_conflict',
  });
  assert.throws(() => verifyFrozenConflict(frozen.slice(0, 1), expected), /changed/i);
});

test('resolves metadata before Slack and attempt creation, then inserts and re-reads all rows', () => {
  const workflow = readWorkflow();
  assert.deepEqual(targets(workflow, 'Start'), ['Normalize Standalone Input']);
  assert.deepEqual(targets(workflow, 'Normalize Standalone Input'), ['Resolve Base Discovery']);
  assert.deepEqual(targets(workflow, 'Resolve Base Discovery'), ['Tag Base Discovery']);
  assert.deepEqual(targets(workflow, 'Tag Base Discovery'), ['Plan Base Discovery Window']);
  assert.deepEqual(targets(workflow, 'Plan Base Discovery Window'), ['Needs Previous Fallback']);
  assert.deepEqual(targets(workflow, 'Needs Previous Fallback', 0), ['Resolve Previous Fallback Discovery']);
  assert.deepEqual(targets(workflow, 'Needs Previous Fallback', 1), ['Final Lookup Context']);
  assert.deepEqual(targets(workflow, 'Resolve Previous Fallback Discovery'), ['Tag Previous Fallback Discovery']);
  assert.deepEqual(targets(workflow, 'Tag Previous Fallback Discovery'), ['Plan Fallback Discovery Window']);
  assert.deepEqual(targets(workflow, 'Plan Fallback Discovery Window'), ['Final Lookup Context']);
  assert.deepEqual(targets(workflow, 'Final Lookup Context'), ['Resolve Final Stream Context']);
  assert.deepEqual(targets(workflow, 'Resolve Final Stream Context'), ['Require Eligible Stream Context']);
  assert.deepEqual(targets(workflow, 'Require Eligible Stream Context'), ['Create Processing Message']);
  assert.deepEqual(targets(workflow, 'Create Processing Message'), ['Build Standalone Attempt']);
  assert.deepEqual(targets(workflow, 'Build Standalone Attempt'), ['Insert Attempt']);
  assert.deepEqual(targets(workflow, 'Insert Attempt'), ['Read All Attempt Rows']);
  const base = nodeByName(workflow, 'Resolve Base Discovery');
  const fallback = nodeByName(workflow, 'Resolve Previous Fallback Discovery');
  const final = nodeByName(workflow, 'Resolve Final Stream Context');
  for (const resolver of [base, fallback, final]) {
    assert.equal(resolver.parameters.workflowId.value, 'StreamMetaV3A001');
    assert.equal(resolver.parameters.workflowId.cachedResultName, 'Stream Metadata: resolve by IDs v3');
    assert.equal(resolver.parameters.workflowInputs.value.profile, 'stt');
    assert.match(resolver.parameters.workflowInputs.value.streams, /liveStreamID/);
    assert.equal(resolver.parameters.options.waitForSubWorkflow, true);
  }
  assert.equal(base.parameters.workflowInputs.value.lookupWindow, '={{ $json.lookupWindow }}');
  assert.equal(fallback.parameters.workflowInputs.value.lookupWindow, '={{ $json.previousFallbackWindow }}');
  assert.equal(final.parameters.workflowInputs.value.lookupWindow, '={{ $json.finalLookupWindow }}');
  assert.equal(nodeByName(workflow, 'Tag Base Discovery').parameters.assignments.assignments[0].value, 'base');
  assert.equal(nodeByName(workflow, 'Tag Previous Fallback Discovery').parameters.assignments.assignments[0].value, 'fallback');
  assert.equal(reachableNodes(workflow, 'Resolve Base Discovery').has('Resolve Final Stream Context'), true);
  assert.equal(reachableNodes(workflow, 'Resolve Previous Fallback Discovery').has('Resolve Final Stream Context'), true);
  assert.equal(reachableNodes(workflow, 'Require Eligible Stream Context').has('Create Processing Message'), true);
  assert.deepEqual(incomingSources(workflow, 'Final Lookup Context'), ['Needs Previous Fallback', 'Plan Fallback Discovery Window']);
  assert.deepEqual(incomingSources(workflow, 'Resolve Final Stream Context'), ['Final Lookup Context']);
  assert.deepEqual(incomingSources(workflow, 'Require Eligible Stream Context'), ['Resolve Final Stream Context']);
  assert.deepEqual(incomingSources(workflow, 'Create Processing Message'), ['Require Eligible Stream Context']);
  for (const discoveryNode of ['Resolve Base Discovery', 'Resolve Previous Fallback Discovery', 'Plan Base Discovery Window', 'Plan Fallback Discovery Window']) {
    assert.notDeepEqual(targets(workflow, discoveryNode), ['Create Processing Message']);
  }
});

test('uses exact-name stt_jobs_v3 placeholders and complete insert mapping only', () => {
  const workflow = readWorkflow();
  const dataTables = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.dataTable');
  assert.ok(dataTables.length >= 5);
  for (const node of dataTables) {
    assert.equal(node.typeVersion, 1.1, node.name);
    assert.deepEqual(node.parameters.dataTableId, { __rl: true, mode: 'name', value: 'stt_jobs_v3' }, node.name);
  }
  const insert = nodeByName(workflow, 'Insert Attempt');
  assert.equal(insert.parameters.operation, 'insert');
  assert.deepEqual(Object.keys(insert.parameters.columns.value), ATTEMPT_FIELDS);
  for (const name of ['Read All Attempt Rows', 'Re-read After Reconciliation', 'Re-read Manual Review State']) {
    const node = nodeByName(workflow, name);
    assert.equal(node.parameters.operation, 'get');
    assert.equal(node.parameters.returnAll, true);
    assert.equal(node.alwaysOutputData, true);
  }
});

test('reconciles with exact soft-CAS, freezes conflicts, and dispatches only a verified ready row', () => {
  const workflow = readWorkflow();
  assert.deepEqual(targets(workflow, 'Is Manual Review Conflict', 0), ['Freeze Conflict Plan']);
  assert.deepEqual(targets(workflow, 'Post-Reconciliation Conflict', 0), ['Freeze Conflict Plan']);
  assert.deepEqual(targets(workflow, 'Freeze Canonical Conflict'), ['Limit Conflict Writes']);
  assert.deepEqual(targets(workflow, 'Limit Conflict Writes'), ['Re-read Manual Review State']);
  assert.deepEqual(targets(workflow, 'Re-read Manual Review State'), ['Verify Frozen Conflict']);
  assert.deepEqual(targets(workflow, 'Verify Frozen Conflict'), []);
  assert.equal(reachableNodes(workflow, 'Freeze Conflict Plan').has('Dispatch Canonical Attempt'), false);
  assert.deepEqual(targets(workflow, 'Apply Reconciliation'), ['Limit Reconciliation Writes']);
  assert.deepEqual(targets(workflow, 'Limit Reconciliation Writes'), ['Re-read After Reconciliation']);
  assert.deepEqual(targets(workflow, 'Re-read After Reconciliation'), ['Verify Reconciled Canonical']);
  assert.deepEqual(targets(workflow, 'Reconciliation Complete', 0), ['Return Accepted Contract']);
  const reconcile = nodeByName(workflow, 'Apply Reconciliation');
  assert.equal(reconcile.parameters.matchType, 'allConditions');
  assert.deepEqual(reconcile.parameters.filters.conditions.map(({ keyName }) => keyName), [
    'id', 'attemptKey', 'reconciliationStatus', 'canonicalRowID',
  ]);
  const freeze = nodeByName(workflow, 'Freeze Canonical Conflict');
  assert.deepEqual(freeze.parameters.filters.conditions.map(({ keyName }) => keyName), [
    'id', 'attemptKey', 'status', 'reconciliationStatus', 'canonicalRowID',
  ]);
});

test('fire-and-forgets only attemptKey and exposes only the accepted output allowlist', () => {
  const workflow = readWorkflow();
  const output = nodeByName(workflow, 'Return Accepted Contract');
  const dispatch = nodeByName(workflow, 'Dispatch Canonical Attempt');
  assert.equal(output.parameters.includeOtherFields, false);
  assert.deepEqual(output.parameters.assignments.assignments.map(({ name }) => name), [
    'accepted', 'attemptKey', 'logicalJobKey', 'requestKey', 'streamID', 'mode', 'channel',
  ]);
  assert.doesNotMatch(JSON.stringify(output.parameters), /streamContext|processingMessageTS|threadTS|canonicalRowID/);
  assert.deepEqual(targets(workflow, 'Return Accepted Contract'), ['Dispatch Canonical Attempt']);
  assert.equal(dispatch.parameters.workflowId.value, 'STTDispatchV3A01');
  assert.equal(dispatch.parameters.workflowId.cachedResultName, 'STT: dispatch attempt v3');
  assert.deepEqual(dispatch.parameters.workflowInputs.value, { attemptKey: '={{ $json.attemptKey }}' });
  assert.equal(dispatch.parameters.options.waitForSubWorkflow, false);
});

test('is inactive and contains no legacy nodes, files, or dangling external references', () => {
  const workflow = readWorkflow();
  assert.equal(workflow.id, 'ReqSTTProcessV3A');
  assert.equal(workflow.name, 'Req STT process v3');
  assert.equal(workflow.active, false);
  const forbiddenTypes = new Set(['n8n-nodes-base.wait', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.googleBigQuery', 'n8n-nodes-base.switch']);
  assert.ok(workflow.nodes.every(({ type }) => !forbiddenTypes.has(type)));
  assert.doesNotMatch(JSON.stringify(workflow), /resumeUrl|STTListenerV3A01|req STT service|query stream info|Send a err message|AISummaryV2/);
  const externalReferences = [...JSON.stringify(workflow).matchAll(/__EXTERNAL_FILE__:\/\/([^"\\]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(externalReferences)].sort(), [
    'nodes/Build_Standalone_Attempt/jsCode.js',
    'nodes/Normalize_Standalone_Input/jsCode.js',
    'nodes/Reconcile_Canonical/jsCode.js',
  ]);
  for (const reference of externalReferences) assert.equal(fs.existsSync(path.join(workflowDir, reference)), true, reference);
  for (const legacy of [
    'nodes/Stream_STT_async1/jsCode.js', 'nodes/compose_input/jsonOutput.jsonc',
    'nodes/Code_in_JavaScript/jsCode.js', 'nodes/query_stream_info/sqlQuery.sql',
  ]) {
    assert.equal(fs.existsSync(path.join(workflowDir, legacy)), false, legacy);
  }
});

test('uses unique UUIDv4 node IDs and only valid, fully reachable connection targets', () => {
  const workflow = readWorkflow();
  const names = new Set(workflow.nodes.map(({ name }) => name));
  const ids = workflow.nodes.map(({ id }) => id);
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => uuidV4.test(id)));
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    assert.ok(names.has(source), `Unknown connection source: ${source}`);
    for (const output of outputs.main || []) {
      for (const connection of output || []) assert.ok(names.has(connection.node), `Unknown target: ${connection.node}`);
    }
  }
  const reachable = reachableNodes(workflow, 'Start');
  assert.deepEqual([...names].filter((name) => name !== 'Start' && !reachable.has(name)), []);
});
