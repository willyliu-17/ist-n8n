const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { buildWorkflow } = require('./utils');
const entry = buildWorkflow(path.resolve(__dirname, '../workflows/ist_bot_entry_v3_IstBotEntryV3A01'));
const { parseBotItem } = require('../workflows/ist_bot_entry_v3_IstBotEntryV3A01/nodes/Command_parser/jsCode');
const { normalizeSummaryCommand } = require('../workflows/ist_bot_entry_v3_IstBotEntryV3A01/nodes/Build_Summary_Resolver_Input/jsCode');

function run(name, inputs, outputs = {}) {
  const source = entry.nodes.find((node) => node.name === name).parameters.jsCode;
  const items = (values) => values.map((json) => ({ json }));
  const result = vm.runInNewContext(`(function () { ${source}\n})()`, {
    $input: { all: () => items(inputs), first: () => items(inputs)[0] },
    $: (node) => {
      if (!Object.hasOwn(outputs, node)) throw new Error(`Node not executed: ${node}`);
      return { all: () => items(outputs[node]), first: () => items(outputs[node])[0] };
    },
  });
  return JSON.parse(JSON.stringify(result)).map(({ json }) => json);
}

function context(id, window, inputIndex = 0) {
  const beginTime = Date.parse(window.start) / 1000 + 3600;
  return { liveStreamID: id, inputIndex, profile: 'stt', source: 'livestream_v2', status: 'found',
    eligible: true, beginTime, endTime: beginTime + 3601, closeBy: 'normalEnd' };
}

function matchesWindow(row, window) {
  return row.beginTime * 1000 >= Date.parse(window.start) && row.beginTime * 1000 < Date.parse(window.end);
}

test('assembled shared Code nodes carry fallback results into one ordered summary request', () => {
  for (const text of ['!stt stream 9001', '!summary stream 9001', '!summary stream 9001 9002']) {
    const command = parseBotItem({ channel: 'C0A4JJJKJMD', ts: '1787364000.000001', event_ts: '1787364000.000001', text });
    const plan = normalizeSummaryCommand(command, '2025-02-01T04:00:00+08:00');
    const paired = plan.positions.length === 2;
    const missing = { liveStreamID: '9001', status: 'not_found', eligible: false };
    const current = context('9002', plan.lookupWindow, 1);
    const base = paired ? [missing, current] : [missing];
    const outputs = { 'Build Summary Resolver Input': [{ plan }], 'Resolve Summary Discovery': base };
    const fallback = run('Build Summary Resolution Plan', base, outputs);
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].phase, 'previous_fallback');
    outputs['Build Summary Resolution Plan'] = fallback;
    const older = context('9001', plan.previousFallbackWindow);
    assert.equal(matchesWindow(older, plan.lookupWindow), false);
    const finalCalls = run('Build Final After Fallback', [older], outputs);
    outputs['Build Final After Fallback'] = finalCalls;
    const finalRows = finalCalls.flatMap((call) => [older, current]
      .filter((row) => call.streams.some(({ liveStreamID }) => liveStreamID === row.liveStreamID) && matchesWindow(row, call.lookupWindow)));
    assert.equal(finalRows.length, paired ? 2 : 1);
    outputs['Resolve Summary Streams'] = finalRows;
    const requests = run('Reassemble Summary Streams', finalRows, outputs);
    outputs['Reassemble Summary Streams'] = requests;
    const messages = requests.map((_, index) => ({ message: { ts: `1787364001.00000${index}` } }));
    const result = run('Build Summary Orchestrator Request', messages, outputs);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].orderedStreams.map(({ liveStreamID, mode, durationMinutes }) => ({ liveStreamID, mode, durationMinutes })), paired
      ? [{ liveStreamID: '9001', mode: 'fromEnd', durationMinutes: 5 }, { liveStreamID: '9002', mode: 'fromStart', durationMinutes: 5 }]
      : [{ liveStreamID: '9001', mode: 'fromStart', durationMinutes: 61 }]);
  }
});

test('dated commands keep half-open five-day bounds across leap-day and year transitions', () => {
  for (const [date, start, end] of [
    ['2024-03-01', '2024-02-28', '2024-03-04'],
    ['2025-01-01', '2024-12-30', '2025-01-04'],
  ]) {
    const plan = normalizeSummaryCommand({ routeKey: 'summary:stream', channel: 'C0A4JJJKJMD', ts: '1787364000.000001',
      args: { date }, positionals: ['9001', '9002'] });
    assert.deepEqual(plan.lookupWindow, { start: `${start}T04:00:00+08:00`, end: `${end}T04:00:00+08:00` });
    const outputs = { 'Build Summary Resolver Input': [{ plan }] };
    assert.throws(() => run('Build Summary Resolution Plan', [
      { liveStreamID: '9001', status: 'not_found', eligible: false }, context('9002', plan.lookupWindow, 1),
    ], outputs), /requested window/);
    const resolver = buildWorkflow(path.resolve(__dirname, '../workflows/stream_metadata_resolve_by_ids_v3_StreamMetaV3A001'));
    const sttSql = resolver.nodes.filter((node) => node.parameters.sqlQuery).map((node) => node.parameters.sqlQuery).join('\n');
    assert.match(sttSql, /beginTime.*>=|>=.*@window_start/);
    assert.match(sttSql, /beginTime.*<|<.*@window_end/);
  }
});

test('explicit STT retains its original route and five-minute default', () => {
  for (const mode of ['first', 'last']) {
    const command = parseBotItem({ channel: 'C0A4JJJKJMD', ts: '1787364000.000001', event_ts: '1787364000.000001', text: `!stt stream 9001 ${mode}` });
    assert.equal(command.dispatchKey, 'v3:stt:stream');
    assert.equal(command.sttMins, 5);
    assert.equal(command.sttMode, mode === 'first' ? 'fromStart' : 'fromEnd');
  }
});
