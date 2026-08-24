const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowDir = path.resolve(__dirname, '..');
const { buildWorkflow } = require('../../../scripts/utils');
const { parseBotItem } = require('../nodes/Command_parser/jsCode');
const {
  buildLookupWindow,
  buildPreviousFallbackWindow,
  buildSummaryResolverCalls,
  chunkIDs,
  extendPairingWindow,
  normalizeSummaryCommand,
} = require('../nodes/Build_Summary_Resolver_Input/jsCode');
const {
  planAfterBaseDiscovery,
  planAfterFallbackDiscovery,
  reassembleSummaryContexts,
} = require('../nodes/Reassemble_Summary_Resolver_Output/jsCode');

const CHANNEL = 'C0A4JJJKJMD';
const THREAD_TS = '1787364000.000001';
const explicitWindow = { start: '2025-01-02T04:00:00+08:00', end: '2025-01-03T04:00:00+08:00' };

function readWorkflow() {
  return JSON.parse(fs.readFileSync(path.join(workflowDir, 'workflow.json'), 'utf8'));
}

function nodeByName(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `Missing node: ${name}`);
  return node;
}

function context(liveStreamID, inputIndex, overrides = {}) {
  return {
    inputIndex,
    status: 'found',
    source: 'livestream_v2',
    profile: 'stt',
    liveStreamID,
    userID: `user-${liveStreamID}`,
    openID: `open-${liveStreamID}`,
    beginTime: 1735759800,
    endTime: 1735885800,
    duration: 3600,
    region: 'TW',
    vliverModel: 1,
    eligible: true,
    ...overrides,
  };
}

test('parses summary and STT aliases at the caller boundary', () => {
  const summary = parseBotItem({ channel: CHANNEL, ts: THREAD_TS, event_ts: THREAD_TS, text: '!summary stream 9001 9002 date=2025-01-02' });
  assert.equal(summary.routeKey, 'summary:stream');
  assert.equal(summary.args.date, '2025-01-02');
  const normalized = normalizeSummaryCommand(summary, '2026-08-22T04:00:00+08:00');
  assert.deepEqual(normalized.positions.map(({ role, mode }) => ({ role, mode })), [
    { role: 'previous', mode: 'fromEnd' },
    { role: 'current', mode: 'fromStart' },
  ]);
  assert.equal(normalized.channel, CHANNEL);
});

test('builds exact default and explicit lookup windows', () => {
  assert.deepEqual(buildLookupWindow({ nowIso: '2025-02-01T09:17:00+08:00' }), {
    start: '2025-01-02T09:17:00+08:00',
    end: '2025-02-01T09:17:00+08:00',
  });
  assert.deepEqual(buildLookupWindow({ date: '2025-01-02' }), explicitWindow);
});

test('extends only outside an explicit base and caps each side at six hours', () => {
  assert.deepEqual(extendPairingWindow(explicitWindow, {
    previousBegin: '2025-01-01T23:30:00+08:00',
    currentEnd: '2025-01-03T08:30:00+08:00',
  }), { start: '2025-01-01T23:30:00+08:00', end: '2025-01-03T08:30:00+08:00' });
  assert.deepEqual(extendPairingWindow(explicitWindow, {
    previousBegin: '2025-01-01T18:00:00+08:00',
    currentEnd: '2025-01-03T14:00:00+08:00',
  }), { start: '2025-01-01T22:00:00+08:00', end: '2025-01-03T10:00:00+08:00' });
  assert.deepEqual(extendPairingWindow(explicitWindow, {
    previousBegin: '2025-01-02T05:00:00+08:00',
    currentEnd: '2025-01-03T03:00:00+08:00',
  }), explicitWindow);
});

test('keeps previousFallbackWindow separate and bounded to 30 days', () => {
  assert.deepEqual(buildPreviousFallbackWindow(explicitWindow), {
    start: '2024-12-03T04:00:00+08:00',
    end: '2025-01-02T04:00:00+08:00',
  });
  assert.throws(() => buildPreviousFallbackWindow(explicitWindow, 31));
});

test('chunks 0, 1, 100, 101, and 250 summary IDs and preserves ordered duplicates', () => {
  for (const size of [0, 1, 100, 101, 250]) {
    const ids = Array.from({ length: size }, (_, index) => String(index + 1));
    assert.deepEqual(chunkIDs(ids).flat(), ids);
    assert.ok(chunkIDs(ids).every((chunk) => chunk.length <= 100));
  }
  const calls = buildSummaryResolverCalls({ ids: ['9001', '9002', '9001'], lookupWindow: explicitWindow });
  assert.equal(calls[0].profile, 'stt');
  assert.deepEqual(calls[0].lookupWindow, explicitWindow);
  assert.deepEqual(calls[0].streams, [{ liveStreamID: '9001' }, { liveStreamID: '9002' }]);
  const rows = [context('9001', 0), context('9002', 1)];
  assert.deepEqual(
    reassembleSummaryContexts(['9001', '9002', '9001', '9999'], rows).map(({ liveStreamID, status }) => ({ liveStreamID, status })),
    [
      { liveStreamID: '9001', status: 'found' },
      { liveStreamID: '9002', status: 'found' },
      { liveStreamID: '9001', status: 'found' },
      { liveStreamID: '9999', status: 'not_found' },
    ],
  );
});

test('requests previous fallback only after an unusable base result', () => {
  const plan = normalizeSummaryCommand({
    routeKey: 'summary:stream', channel: CHANNEL, ts: THREAD_TS,
    args: { date: '2025-01-02' }, positionals: ['9001', '9002'],
  });
  const current = context('9002', 1, { beginTime: 1735804800, endTime: 1735885800 });
  const fallbackCalls = planAfterBaseDiscovery(plan, [
    context('9001', 0, { status: 'not_found', eligible: false }), current,
  ]);
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0].phase, 'previous_fallback');
  assert.deepEqual(fallbackCalls[0].lookupWindow, plan.previousFallbackWindow);
  const previous = context('9001', 0, {
    beginTime: Date.parse('2025-01-01T23:30:00+08:00') / 1000,
    endTime: Date.parse('2025-01-02T03:30:00+08:00') / 1000,
  });
  const finalCalls = planAfterFallbackDiscovery(plan, [current], [previous]);
  assert.equal(finalCalls[0].phase, 'final');
  assert.notDeepEqual(finalCalls[0].lookupWindow, plan.previousFallbackWindow);
  assert.ok(Date.parse(finalCalls[0].lookupWindow.start) <= previous.beginTime * 1000);

  const directFinal = planAfterBaseDiscovery(plan, [previous, current]);
  assert.equal(directFinal[0].phase, 'final');

  const beyondCap = context('9001', 0, {
    beginTime: Date.parse('2025-01-01T18:00:00+08:00') / 1000,
    endTime: Date.parse('2025-01-01T22:00:00+08:00') / 1000,
  });
  assert.throws(
    () => planAfterFallbackDiscovery(plan, [current], [beyondCap]),
    /outside the bounded final lookup window/,
  );
});

test('extends a default 30-day final window within resolver limits', () => {
  const plan = normalizeSummaryCommand({
    routeKey: 'summary:stream', channel: CHANNEL, ts: THREAD_TS,
    args: {}, positionals: ['9001', '9002'],
  }, '2025-02-01T04:00:00+08:00');
  assert.deepEqual(plan.lookupWindow, {
    start: '2025-01-02T04:00:00+08:00',
    end: '2025-02-01T04:00:00+08:00',
  });
  const previous = context('9001', 0, {
    beginTime: Date.parse('2025-01-02T01:00:00+08:00') / 1000,
    endTime: Date.parse('2025-01-02T03:00:00+08:00') / 1000,
  });
  const current = context('9002', 1, {
    beginTime: Date.parse('2025-01-31T20:00:00+08:00') / 1000,
    endTime: Date.parse('2025-02-01T04:00:00+08:00') / 1000,
  });
  const calls = planAfterFallbackDiscovery(plan, [current], [previous]);
  assert.equal(calls[0].lookupWindow.start, '2025-01-02T01:00:00+08:00');
  assert.equal(calls[0].lookupWindow.end, plan.lookupWindow.end);
  assert.ok(Date.parse(calls[0].lookupWindow.end) - Date.parse(calls[0].lookupWindow.start) <= 31 * 24 * 60 * 60 * 1000);
});

test('routes summary through STT resolver and orchestrator while STT remains resolver-free', () => {
  const workflow = readWorkflow();
  assert.equal(workflow.active, false);
  assert.equal(nodeByName(workflow, 'Command Parser').parameters.mode, 'runOnceForAllItems');
  assert.equal(nodeByName(workflow, 'Resolve Summary Discovery').parameters.workflowId.value, 'StreamMetaV3A001');
  assert.equal(nodeByName(workflow, 'Resolve Summary Previous Fallback').parameters.workflowId.value, 'StreamMetaV3A001');
  assert.equal(nodeByName(workflow, 'Resolve Summary Streams').parameters.workflowId.value, 'StreamMetaV3A001');
  assert.equal(nodeByName(workflow, 'Call Summary Orchestrator').parameters.workflowId.value, 'SummaryOrchV3A01');

  const stt = nodeByName(workflow, 'Call Req. STT process');
  assert.deepEqual(Object.keys(stt.parameters.workflowInputs.value).sort(), [
    'channel', 'date', 'mins', 'mode', 'streamID', 'target_thread_ts',
  ]);
  assert.equal(stt.parameters.workflowInputs.schema.find(({ id }) => id === 'mins').type, 'number');
  assert.equal(stt.parameters.workflowInputs.convertFieldsToString, false);

  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /AISummaryV3A0001|sOSbXSfXFcMLeIfr|channelID|C09F0SYG57D/);
  assert.doesNotThrow(() => buildWorkflow(workflowDir));
});
