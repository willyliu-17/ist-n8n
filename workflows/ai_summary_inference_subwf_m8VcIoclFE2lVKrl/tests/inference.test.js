const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { buildWorkflow } = require('../../../scripts/utils');

const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflow.json'), 'utf8'));

test('retries transient Streamer Log Analyzer failures with bounded attempts', () => {
  const node = workflow.nodes.find((item) => item.name === 'Streamer_Log_Analyzer');
  assert.equal(node.retryOnFail, true);
  assert.equal(node.maxTries, 3);
  assert.equal(node.waitBetweenTries, 2000);
});

test('prompts distinguish transcript outcomes and prohibit raw IP output', () => {
  const prompt = (name) => fs.readFileSync(path.join(__dirname, '..', 'nodes', name, 'options_systemMessage.md'), 'utf8');

  assert.match(prompt('Dialogue_Analyzer'), /transcript\.outcome/);
  assert.match(prompt('Dialogue_Analyzer'), /empty.*不是查詢失敗/);
  assert.match(prompt('StreamInfo_Analyzer'), /publicIP.*不可輸出完整 IP/);
  assert.match(prompt('Streamer_Log_Analyzer'), /UserIP.*IPRegion.*不可輸出完整 IP/);
  assert.match(prompt('AI_Agent'), /最終輸出禁止包含完整 IP/);
});

const root = path.resolve(__dirname, '..');
const built = buildWorkflow(root);
const byName = (name) => built.nodes.find((node) => node.name === name);

function render(expression, analysisMode, data = []) {
  const context = {
    $: (name) => ({ first: () => ({ json: name === 'Start' ? { analysisMode } : { data } }) }),
    $fromAI: () => 'Inspect the evidence',
  };
  if (!expression.startsWith('=')) return expression;
  return expression.slice(1).replace(/\{\{([\s\S]*?)\}\}/g, (_, source) => String(vm.runInNewContext(source, context)));
}

function aggregate() {
  return [{ liveStreamID: '9001', details: [
    { type: 'dialogue', liveStreamID: '9001', dialogue: '[12:00:00] normal stream', transcript: { outcome: 'transcribed' } },
    { type: 'streamInfo', liveStreamID: '9001', streamInfo: [{ closeBy: 'normalEnd' }] },
    { type: 'streamerLog', liveStreamID: '9001', logs: [{ bitrate: 1000 }] },
    { type: 'streamEventLog', liveStreamID: '9001', logs: [{ title: 'End Live Success' }] },
  ] }];
}

test('legacy rendered system prompts and schema content remain unchanged', () => {
  const fixtures = [
    [byName('AI Agent').parameters.options.systemMessage, '3c34fe08a88c30a97ba141877615d36061881110ffcde408393ab47d858c57ab'],
    [byName('Dialogue_Analyzer').parameters.options.systemMessage, '47be4e7d9d1133a59cd04a9782f980da6e08f956010f213457824ace29850432'],
    [byName('Structured Output Parser').parameters.inputSchema, 'b2d93a67e490cae484643feef0858de8ac6408f9e14f3569e8cd391d18fd7a0c', true],
  ];
  for (const mode of [undefined, null, '', 'legacy']) {
    for (const [expression, expected, schema] of fixtures) {
      const rendered = render(expression, mode);
      assert.equal(createHash('sha256').update(schema ? rendered.trimEnd() : rendered).digest('hex'), expected);
    }
  }
});

test('legacy analyzer payloads preserve data and do not opt a one-stream suspect into full mode', () => {
  const data = aggregate();
  const types = { Dialogue_Analyzer: 'dialogue', Streamer_Log_Analyzer: 'streamerLog', Event_Log_Analyzer: 'streamEventLog', StreamInfo_Analyzer: 'streamInfo' };
  for (const [name, type] of Object.entries(types)) {
    const expected = { request: 'Inspect the evidence', data: data[0].details.filter((detail) => detail.type === type) };
    assert.equal(render(byName(name).parameters.text, undefined, data).trim(), JSON.stringify(expected, null, 2));
    const empty = JSON.parse(render(byName(name).parameters.text, undefined));
    assert.deepEqual(empty, { request: 'Inspect the evidence', data: [], notice: `無對應的 ${type} 資料，請回報無資料。` });
  }
  for (const [items, count] of [[data, 1], [[...data, { ...data[0], liveStreamID: '9002' }], 2], [[...data, ...data], 1]]) {
    assert.equal(render(byName('AI Agent').parameters.text, '', items).trim(), `目前共有 ${count} 筆 liveStreamID。請先判斷是否需要呼叫 Analyzer Tools（Streamer_Log_Analyzer / Event_Log_Analyzer / Dialogue_Analyzer / StreamInfo_Analyzer）。若資料不足就不要呼叫。`);
  }
  assert.equal(render(byName('AI Agent').parameters.text, '').trim(), '目前無可分析資料，請勿呼叫任何 Analyzer Tools，直接回報無資料。');
});

test('single-stream prompts are explicit about scope, evidence coverage, and unavailable dialogue', () => {
  const mode = 'single_stream_full';
  const data = aggregate();
  const system = render(byName('AI Agent').parameters.options.systemMessage, mode);
  assert.match(system, /不要預設有異常、中斷、前場或重開/);
  assert.match(system, /跨場重開後的恢復不適用/);
  assert.match(system, /不得聲稱主 Agent 直接閱讀全部原文/);
  assert.doesNotMatch(system, /還原直播中斷的真相|修復比對重開後|所有直播場次視為連續事件/);
  const dialogueSystem = render(byName('Dialogue_Analyzer').parameters.options.systemMessage, mode);
  assert.match(dialogueSystem, /chunked_evidence/);
  assert.match(dialogueSystem, /不可用證據|無文字或失敗不代表無異常/);
  for (const name of ['Dialogue_Analyzer', 'Streamer_Log_Analyzer', 'Event_Log_Analyzer', 'StreamInfo_Analyzer']) {
    const payload = JSON.parse(render(byName(name).parameters.text, mode, data));
    assert.equal(payload.analysisMode, mode);
    assert.match(payload.scope, /本場/);
  }
  data[0].details[0].dialogueCoverage = { kind: 'chunked_evidence', totalChunks: 6, completedChunks: 6 };
  assert.match(render(byName('AI Agent').parameters.text, mode, data), /"completedChunks":6/);
  data[0].details[0].transcript.outcome = 'timed_out';
  data[0].details[0].dialogue = '';
  assert.match(render(byName('AI Agent').parameters.text, mode, data), /timed_out.*不是完整對話摘要/);
});

test('single-stream schema only changes descriptions, not required fields or enums', () => {
  const expression = byName('Structured Output Parser').parameters.inputSchema;
  const legacy = JSON.parse(render(expression));
  const single = JSON.parse(render(expression, 'single_stream_full'));
  function withoutDescriptions(value) {
    if (Array.isArray(value)) return value.map(withoutDescriptions);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, nested]) => [key, withoutDescriptions(nested)]));
    return value;
  }
  assert.deepEqual(withoutDescriptions(single), withoutDescriptions(legacy));
  assert.match(single.properties.report.properties.subjective_motivation.properties.recovery_status.description, /跨場重開後恢復不適用/);
  assert.match(single.properties.report.properties.summary.properties.responsibility_category_list.description, /空陣列/);
  assert.doesNotMatch(single.properties.report.properties.summary.properties.causal_summary.description, /前一場關播原因/);
});
