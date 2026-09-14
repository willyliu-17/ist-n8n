const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowDir = path.resolve(__dirname, '..');
const { buildWorkflow } = require('../../../scripts/utils');
const { CHANNEL_COMMANDS, parseBotItem } = require('../nodes/Command_parser/jsCode');
const {
  buildLookupWindow,
  buildSingleStreamLookupWindow,
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
  buildOrderedSummaryStreams,
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
    closeBy: 'normalEnd',
    ...overrides,
  };
}

test('parses summary and STT aliases at the caller boundary', () => {
  const messageTS = '1787364000.000002';
  const summary = parseBotItem({ event: {
    channel: CHANNEL,
    ts: messageTS,
    event_ts: messageTS,
    thread_ts: THREAD_TS,
    text: '!summary stream 9001 9002 date=2025-01-02',
  } });
  assert.equal(summary.routeKey, 'summary:stream');
  assert.equal(summary.args.date, '2025-01-02');
  assert.equal(summary.thread_ts, THREAD_TS);
  const normalized = normalizeSummaryCommand(summary, '2026-08-22T04:00:00+08:00');
  assert.deepEqual(normalized.positions.map(({ role, mode }) => ({ role, mode })), [
    { role: 'previous', mode: 'fromEnd' },
    { role: 'current', mode: 'fromStart' },
  ]);
  assert.equal(normalized.channel, CHANNEL);
  assert.equal(normalized.threadTS, THREAD_TS);
  assert.equal(normalized.requestKey, `bot-summary:${messageTS}:9001:9002`);
  assert.match(normalized.requestKey, new RegExp(messageTS.replace('.', '\\.')));

  const stt = parseBotItem({ event: {
    channel: CHANNEL,
    ts: messageTS,
    event_ts: messageTS,
    text: '!stt stream 215215725',
  } });
  assert.equal(stt.routeKey, 'stt:stream');
  assert.equal(stt.dispatchKey, 'v3:summary:stream');
  assert.equal(normalizeSummaryCommand(stt).requestType, 'single_stream_summary');
  assert.equal(stt.sttMode, undefined);
  assert.equal(stt.sttMins, undefined);
  assert.equal(stt.thread_ts, messageTS);

  const threadedStt = parseBotItem({ event: {
    channel: CHANNEL,
    ts: '1787364001.000003',
    event_ts: '1787364001.000003',
    thread_ts: THREAD_TS,
    text: '!stt stream 215215725',
  } });
  assert.equal(threadedStt.ts, '1787364001.000003');
  assert.equal(threadedStt.thread_ts, THREAD_TS);

  const explicit = parseBotItem({ event: {
    channel: CHANNEL,
    ts: messageTS,
    event_ts: messageTS,
    text: '!stt stream 215215725 first 3',
  } });
  assert.equal(explicit.sttMode, 'fromStart');
  assert.equal(explicit.sttMins, 3);
});

test('routes each enabled configuration once and ignores disabled, bot, subtype, and unknown events', () => {
  for (const [channel, commands] of Object.entries(CHANNEL_COMMANDS)) {
    for (const [routeKey, enabled] of Object.entries(commands)) {
      assert.equal(enabled, true);
      const [group, action] = routeKey.split(':');
      const parsed = parseBotItem({ event: { channel, ts: THREAD_TS, event_ts: THREAD_TS, text: `!${group} ${action}` } });
      assert.equal(parsed.dispatchKey, `v3:${routeKey}`);
      const disabled = Object.fromEntries(Object.entries(CHANNEL_COMMANDS)
        .map(([configuredChannel, configuredCommands]) => [configuredChannel, { ...configuredCommands }]));
      disabled[channel][routeKey] = false;
      assert.equal(parseBotItem({ event: { channel, ts: THREAD_TS, event_ts: THREAD_TS, text: `!${group} ${action}` } }, disabled), null);
    }
  }
  assert.throws(() => parseBotItem({ event: [] }), /event must be an object/);
  assert.equal(parseBotItem({ event: {
    channel: 'C09F0SYG57D', ts: THREAD_TS, event_ts: THREAD_TS, text: '!stt ping',
  } }).dispatchKey, 'legacy');
  assert.equal(parseBotItem({ event: {
    channel: 'C0A4JJJKJMD', ts: THREAD_TS, event_ts: THREAD_TS, text: '!other command',
  } }), null);
  assert.equal(parseBotItem({ event: {
    channel: 'CUNKNOWN', ts: THREAD_TS, event_ts: THREAD_TS, text: '!stt stream 9001',
  } }), null);
  assert.equal(parseBotItem({ event: {
    channel: CHANNEL, ts: THREAD_TS, event_ts: THREAD_TS, text: '!stt ping', bot_id: 'B01',
  } }), null);
  assert.equal(parseBotItem({ event: {
    channel: CHANNEL, ts: THREAD_TS, event_ts: THREAD_TS, text: '!stt ping', subtype: 'message_changed',
  } }), null);
});

test('preserves rich-text commands and the complete original event for Legacy', () => {
  const rich = parseBotItem({ event: {
    channel: CHANNEL, ts: THREAD_TS, event_ts: THREAD_TS,
    blocks: [{ elements: [{ elements: [{ text: '!STT STREAM 9001 FIRST 3' }] }] }],
  } });
  assert.equal(rich.dispatchKey, 'v3:stt:stream');
  assert.equal(rich.sttMode, 'FIRST');
  assert.equal(nodeByName(readWorkflow(), 'Call Legacy Entry').parameters.workflowInputs.value.event, "={{ $('Start').item.json.event }}");
});

test('builds exact default and explicit lookup windows', () => {
  assert.deepEqual(buildLookupWindow({ nowIso: '2025-02-01T09:17:00+08:00' }), {
    start: '2025-01-02T09:17:00+08:00',
    end: '2025-02-01T09:17:00+08:00',
  });
  assert.deepEqual(buildLookupWindow({ date: '2025-01-02' }), {
    start: '2024-12-31T04:00:00+08:00', end: '2025-01-05T04:00:00+08:00',
  });
});

test('plans a single stream with a five-business-day date window and full-stream duration', () => {
  const messageTS = '1787364000.000002';
  const command = parseBotItem({ event: {
    channel: CHANNEL, ts: messageTS, event_ts: messageTS, text: '!summary stream 9001 date=2025-01-02',
  } });
  const plan = normalizeSummaryCommand(command, '2025-02-01T09:17:00+08:00');
  assert.equal(plan.requestKey, `bot-summary:${messageTS}:9001`);
  assert.equal(plan.requestType, 'single_stream_summary');
  assert.deepEqual(plan.positions, [{ originalIndex: 0, role: 'current', liveStreamID: '9001', mode: 'fromStart' }]);
  assert.equal(Object.hasOwn(plan, 'previousFallbackWindow'), false);
  assert.deepEqual(plan.lookupWindow, {
    start: '2024-12-31T04:00:00+08:00', end: '2025-01-05T04:00:00+08:00',
  });
  assert.deepEqual(buildSingleStreamLookupWindow({ date: '2025-01-01' }), {
    start: '2024-12-30T04:00:00+08:00', end: '2025-01-04T04:00:00+08:00',
  });
  assert.deepEqual(buildSingleStreamLookupWindow({ nowIso: '2025-02-01T09:17:00+08:00' }), {
    start: '2025-01-02T09:17:00+08:00', end: '2025-02-01T09:17:00+08:00',
  });

  const current = context('9001', 0, { beginTime: 1735689600, endTime: 1735690501 });
  const calls = planAfterBaseDiscovery(plan, [current]);
  assert.deepEqual(calls.map(({ phase, streams, lookupWindow }) => ({ phase, streams, lookupWindow })), [{
    phase: 'final', streams: [{ liveStreamID: '9001' }], lookupWindow: plan.lookupWindow,
  }]);
  assert.deepEqual(buildOrderedSummaryStreams(plan, [current]).map(({ role, mode, durationMinutes, liveStreamID }) => ({
    role, mode, durationMinutes, liveStreamID,
  })), [{ role: 'current', mode: 'fromStart', durationMinutes: 16, liveStreamID: '9001' }]);
});

test('rejects invalid single stream commands and non-ended metadata without previous fallback', () => {
  for (const positionals of [[], ['1', '2', '3'], ['not-an-id']]) {
    assert.throws(() => normalizeSummaryCommand({
      routeKey: 'summary:stream', channel: CHANNEL, ts: THREAD_TS, args: {}, positionals,
    }));
  }
  const plan = normalizeSummaryCommand({
    routeKey: 'summary:stream', channel: CHANNEL, ts: THREAD_TS, args: {}, positionals: ['9001'],
  });
  assert.throws(() => planAfterBaseDiscovery(plan, [context('9001', 0, { endTime: 1735759800 })]), /ended time range/);
  assert.throws(() => planAfterBaseDiscovery(plan, [context('9001', 0, { closeBy: '' })]), /closing marker/);
  assert.throws(() => planAfterBaseDiscovery(plan, [context('9001', 0, {
    beginTime: Math.floor(Date.now() / 1000) - 60,
    endTime: Math.floor(Date.now() / 1000) + 60,
  })]), /has not ended yet/);
});

test('full-stream aliases resolve older metadata through one fallback and preserve full duration', () => {
  for (const group of ['stt', 'summary']) {
    const command = parseBotItem({ event: {
      channel: CHANNEL, ts: THREAD_TS, event_ts: THREAD_TS, text: `!${group} stream 9001`,
    } });
    const plan = normalizeSummaryCommand(command, '2025-02-01T04:00:00+08:00');
    const missing = context('9001', 0, { status: 'not_found', eligible: false });
    const calls = planAfterBaseDiscovery(plan, [missing]);
    assert.equal(calls[0].phase, 'previous_fallback');
    assert.deepEqual(calls[0].lookupWindow, {
      start: '2024-12-03T04:00:00+08:00', end: '2025-01-02T04:00:00+08:00',
    });
    const older = context('9001', 0, {
      beginTime: Date.parse('2024-12-10T04:00:00+08:00') / 1000,
      endTime: Date.parse('2024-12-10T06:00:01+08:00') / 1000,
    });
    const final = planAfterFallbackDiscovery(plan, [missing], [older]);
    assert.equal(final.length, 1);
    assert.deepEqual(final[0].lookupWindow, calls[0].lookupWindow);
    assert.equal(buildOrderedSummaryStreams(final[0].plan, [older])[0].durationMinutes, 121);
    assert.throws(() => planAfterFallbackDiscovery(plan, [missing], [missing]), /eligible/);
    assert.throws(() => planAfterBaseDiscovery(plan, [context('9001', 0, { status: 'partial', eligible: false })]), /requested window/);
  }
});

test('dated single and paired commands never fallback or extend the five-day window', () => {
  for (const ids of [['9001'], ['9001', '9002']]) {
    const plan = normalizeSummaryCommand({
      routeKey: 'summary:stream', channel: CHANNEL, ts: THREAD_TS,
      args: { date: '2025-01-02' }, positionals: ids,
    });
    const missing = context('9001', 0, { status: 'not_found', eligible: false });
    const current = context('9002', 1);
    assert.equal(Object.hasOwn(plan, 'previousFallbackWindow'), false);
    assert.throws(() => planAfterBaseDiscovery(plan, [missing, current]), /requested window/);
    assert.throws(() => planAfterFallbackDiscovery(plan, [current], [context('9001', 0)]), /not allowed/);
    const calls = planAfterBaseDiscovery(plan, [context('9001', 0), current]);
    assert.deepEqual(calls[0].lookupWindow, plan.lookupWindow);
    assert.equal(calls[0].phase, 'final');
  }
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

test('requests previous fallback only after an undated not-found base result', () => {
  const plan = normalizeSummaryCommand({
    routeKey: 'summary:stream', channel: CHANNEL, ts: THREAD_TS,
    args: {}, positionals: ['9001', '9002'],
  }, '2025-02-01T04:00:00+08:00');
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
  assert.deepEqual(finalCalls[0].lookupWindow, plan.previousFallbackWindow);
  assert.deepEqual(finalCalls[1].lookupWindow, plan.lookupWindow);
  assert.ok(Date.parse(finalCalls[0].lookupWindow.start) <= previous.beginTime * 1000);

  const directFinal = planAfterBaseDiscovery(plan, [context('9001', 0, { beginTime: current.beginTime }), current]);
  assert.equal(directFinal[0].phase, 'final');

  const beyondCap = context('9001', 0, {
    beginTime: Date.parse('2024-12-02T18:00:00+08:00') / 1000,
    endTime: Date.parse('2024-12-02T22:00:00+08:00') / 1000,
  });
  assert.throws(
    () => planAfterFallbackDiscovery(plan, [current], [beyondCap]),
    /outside the bounded final lookup window/,
  );
});

test('resolves fallback pairs in separate bounded windows without expanding to 60 days', () => {
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
  assert.deepEqual(calls[0].lookupWindow, plan.previousFallbackWindow);
  assert.deepEqual(calls[1].lookupWindow, plan.lookupWindow);
  assert.equal(nodeByName(readWorkflow(), 'Resolve Summary Streams').parameters.mode, 'each');
  assert.ok(Date.parse(calls[0].lookupWindow.end) - Date.parse(calls[0].lookupWindow.start) <= 31 * 24 * 60 * 60 * 1000);
});

test('routes summary through STT resolver and orchestrator while explicit STT uses the adapter', () => {
  const workflow = readWorkflow();
  assert.equal(workflow.active, true);
  assert.deepEqual(Object.fromEntries(['saveDataSuccessExecution', 'saveDataErrorExecution', 'saveManualExecutions', 'saveExecutionProgress'].map((key) => [key, workflow.settings[key]])), {
    saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true, saveExecutionProgress: false,
  });
  const starts = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.executeWorkflowTrigger');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].typeVersion, 1.1);
  assert.deepEqual(starts[0].parameters.workflowInputs.values, [{ name: 'event', type: 'object' }]);
  assert.equal(workflow.nodes.some(({ type }) => type === 'n8n-nodes-base.slackTrigger'), false);
  assert.deepEqual(workflow.connections.Start.main, [[{ node: 'Command Parser', type: 'main', index: 0 }]]);
  assert.equal(nodeByName(workflow, 'Command Parser').parameters.mode ?? 'runOnceForAllItems', 'runOnceForAllItems');
  assert.equal(nodeByName(workflow, 'Resolve Summary Discovery').parameters.workflowId.value, 'StreamMetaV3A001');
  assert.equal(nodeByName(workflow, 'Resolve Summary Previous Fallback').parameters.workflowId.value, 'StreamMetaV3A001');
  assert.equal(nodeByName(workflow, 'Resolve Summary Streams').parameters.workflowId.value, 'StreamMetaV3A001');
  assert.equal(nodeByName(workflow, 'Call Summary Orchestrator').parameters.workflowId.value, 'SummaryOrchV3A01');

  const stt = nodeByName(workflow, 'Call Req. STT process');
  assert.deepEqual(Object.keys(stt.parameters.workflowInputs.value).sort(), [
    'channel', 'command_ts', 'date', 'mins', 'mode', 'streamID', 'target_thread_ts',
  ]);
  assert.equal(stt.parameters.workflowInputs.schema.find(({ id }) => id === 'mins').type, 'number');
  assert.equal(stt.parameters.workflowInputs.convertFieldsToString, false);
  assert.equal(stt.parameters.workflowInputs.value.mode, '={{ $json.sttMode }}');
  assert.equal(stt.parameters.workflowInputs.value.mins, '={{ $json.sttMins }}');
  assert.equal(stt.parameters.workflowInputs.value.command_ts, '={{ $json.ts }}');
  assert.equal(stt.parameters.workflowInputs.value.target_thread_ts, '={{ $json.thread_ts }}');
  assert.equal(stt.parameters.workflowInputs.value.channel, '={{ $json.channel }}');
  assert.equal(stt.parameters.workflowInputs.schema.find(({ id }) => id === 'command_ts').type, 'string');
  // The editor cache is optional; the mapped value and callee validation remain mandatory.
  assert.equal(stt.parameters.workflowInputs.schema.find(({ id }) => id === 'command_ts').required, false);
  assert.equal(nodeByName(workflow, 'Call Query Stream Logs').parameters.workflowInputs.value.channel, '={{ $json.channel }}');
  assert.equal(nodeByName(workflow, 'Call Query Stream Logs').parameters.workflowInputs.value.target_thread_ts, '={{ $json.thread_ts }}');
  assert.equal(nodeByName(workflow, 'Call Tencent Realtime VDS').parameters.workflowInputs.value.channel, '={{ $json.channel }}');
  assert.equal(nodeByName(workflow, 'Call Tencent Realtime VDS').parameters.workflowInputs.value.target_thread_ts, '={{ $json.thread_ts }}');
  assert.equal(nodeByName(workflow, 'Send Summary Processing Message').parameters.channelId.value, '={{ $json.plan.channel }}');
  const vdsWorkflow = JSON.parse(fs.readFileSync(path.resolve(workflowDir, '..', 'tencent_realtime_vds_v3_TencentVDSV3A001', 'workflow.json'), 'utf8'));
  const normalizeInput = nodeByName(vdsWorkflow, 'Normalize Input');
  assert.match(normalizeInput.parameters.assignments.assignments.find(({ name }) => name === 'channelId').value, /C0A4JJJKJMD.*C09F0SYG57D/);
  for (const node of vdsWorkflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.slack')) {
    const channelId = node.parameters.channelId?.value ?? node.parameters.options?.channelId;
    assert.equal(channelId, "={{ $('Normalize Input').first().json.channelId }}", `${node.name} channel`);
  }

  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /AISummaryV3A0001|sOSbXSfXFcMLeIfr|channelID/);
  assert.doesNotThrow(() => buildWorkflow(workflowDir));
});
