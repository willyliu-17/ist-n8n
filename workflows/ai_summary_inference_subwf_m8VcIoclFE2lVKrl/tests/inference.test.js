const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { buildWorkflow } = require('../../../scripts/utils');
const { validateInferenceReport } = require('../nodes/Validate_Inference_Report/jsCode');
const { buildAnalysisScope } = require('../nodes/Long_Dialogue_Preflight/jsCode');

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
function inferenceErrorCode(source) {
  const expression = byName('Raise Inference Error').parameters.errorMessage.trim();
  return vm.runInNewContext(expression.slice(3, -2), { $json: source });
}

function render(expression, analysisMode, data = [], focus = 'Inspect the evidence', suppliedScope) {
  const analysisScope = buildAnalysisScope({ aggregateData: data, analysisMode, analysisScope: suppliedScope });
  const context = {
    $: (name) => ({ first: () => ({ json: name === 'Start' ? { analysisMode } : name === 'Long Dialogue Preflight' ? { analysisScope } : { data } }) }),
    $fromAI: () => focus,
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

test('unrelated legacy dialogue system prompt remains unchanged', () => {
  const fixtures = [
    [byName('Dialogue_Analyzer').parameters.options.systemMessage, '47be4e7d9d1133a59cd04a9782f980da6e08f956010f213457824ace29850432'],
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
    const payload = JSON.parse(render(byName(name).parameters.text, undefined, data));
    assert.deepEqual(payload.data, data[0].details.filter((detail) => detail.type === type));
    assert.equal(payload.analysisFocus, 'Inspect the evidence');
    assert.equal(payload.analysisScope.analysisMode, 'comparison');
    assert.deepEqual(payload.analysisScope.requestedStreams, [{ liveStreamID: '9001', role: 'unspecified' }]);
    const empty = JSON.parse(render(byName(name).parameters.text, undefined));
    assert.deepEqual(empty.data, []);
    assert.equal(empty.notice, `無對應的 ${type} 資料，請回報無資料。`);
  }
  assert.match(render(byName('AI Agent').parameters.text, '', data), /目前共有 1 筆 liveStreamID：9001/);
  assert.match(render(byName('AI Agent').parameters.text, ''), /目前無可分析資料，請勿呼叫任何 Analyzer Tools/);
});

test('single-stream prompts are explicit about scope, evidence coverage, and unavailable dialogue', () => {
  const mode = 'single_stream_full';
  const data = aggregate();
  const system = render(byName('AI Agent').parameters.options.systemMessage, mode, data);
  assert.match(system, /不要預設有異常、中斷、前場或重開/);
  assert.match(system, /跨場重開後的恢復不適用/);
  assert.match(system, /不得聲稱主 Agent 直接閱讀全部原文/);
  assert.doesNotMatch(system, /還原直播中斷的真相|修復比對重開後|所有直播場次視為連續事件/);
  const dialogueSystem = render(byName('Dialogue_Analyzer').parameters.options.systemMessage, mode, data);
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
  const single = JSON.parse(render(expression, 'single_stream_full', aggregate()));
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

test('sanitizes the observed empty-generation error without leaking provider text', () => {
  const observed = "Cannot read properties of undefined (reading 'message')";
  assert.equal(inferenceErrorCode({ error: observed }), 'summary_model_empty_response');
  assert.equal(inferenceErrorCode({ error: { message: observed } }), 'summary_model_empty_response');
  assert.equal(inferenceErrorCode({ error: 'Model output does not fit required format' }), 'summary_model_output_invalid');
  assert.equal(inferenceErrorCode({ error: 'Failed to parse secret transcript' }), 'summary_model_output_invalid');
  assert.equal(inferenceErrorCode({ error: 'https://example.invalid/?token=secret' }), 'summary_inference_failed');
  assert.equal(inferenceErrorCode({}), 'summary_inference_failed');
});

test('whole-agent retries belong to Summary and every inference outcome has a guarded path', () => {
  const agent = byName('AI Agent');
  assert.notEqual(agent.retryOnFail, true);
  assert.equal(agent.alwaysOutputData, true);
  assert.equal(agent.onError, 'continueErrorOutput');
  assert.deepEqual(built.connections['AI Agent'].main, [
    [{ node: 'Validate Inference Report', type: 'main', index: 0 }],
    [{ node: 'Raise Inference Error', type: 'main', index: 0 }],
  ]);
  assert.equal(byName('Raise Inference Error').type, 'n8n-nodes-base.stopAndError');
  assert.equal(byName('Raise Inference Error').parameters.errorType, 'errorMessage');
});

test('validates the schema-shaped report and fails closed on empty or partial model outputs', () => {
  const schema = JSON.parse(render(byName('Structured Output Parser').parameters.inputSchema));
  function sample(spec) {
    if (spec.type === 'object') return Object.fromEntries(Object.entries(spec.properties).map(([key, value]) => [key, sample(value)]));
    if (spec.type === 'array') return [];
    return 'Evidence-based result';
  }
  const output = sample(schema);
  const expectedScope = buildAnalysisScope({ aggregateData: aggregate() });
  output.analysisScope = expectedScope;
  assert.deepEqual(validateInferenceReport([{ output }], expectedScope), { output });
  for (const items of [[], [{}], [{ output: '' }], [{ output: { report: {} } }], [{ output }, { output }]]) {
    assert.throws(() => validateInferenceReport(items), /summary_model_output_invalid/);
  }
  const malformed = structuredClone(output);
  malformed.report.summary.causal_summary = '';
  assert.throws(() => validateInferenceReport([{ output: malformed }]), /summary_model_output_invalid/);
  delete malformed.report.summary.fact_check;
  assert.throws(() => validateInferenceReport([{ output: malformed }]), /summary_model_output_invalid/);
  assert.throws(() => vm.runInNewContext(`(function () { ${byName('Validate Inference Report').parameters.jsCode} })()`, {
    $input: { all: () => [{ json: {} }] },
  }), /summary_model_output_invalid/);
});

function incidentInput(analysisMode) {
  const ids = analysisMode === 'single_stream_full' ? ['215321109'] : ['215320756', '215321109'];
  const aggregateData = ids.map((liveStreamID, index) => ({ liveStreamID, details: aggregate()[0].details.map((detail) => ({
    ...structuredClone(detail), liveStreamID, ...(detail.type === 'dialogue' ? { role: ids.length === 1 || index === 1 ? 'current' : 'previous' } : {}),
  })) }));
  return { aggregateData, analysisMode, analysisScope: {
    requestedStreams: aggregateData.map((stream) => ({ liveStreamID: stream.liveStreamID, role: stream.details[0].role })),
    missingDialogueRoles: [], coverageStatus: 'complete',
  } };
}

function validReport(scope) {
  return { analysisScope: structuredClone(scope), report: {
    subjective_motivation: { timeline_overview: 'Provided streams', subjective_description: 'Available evidence', recovery_status: 'Unknown' },
    sl_analysis: 'No conclusion', sel_analysis: 'No conclusion', summary: {
      responsibility_category: '', responsibility_category_list: [], causal_summary: 'Evidence is limited', other_issue: '',
      fact_check: { claimed_issue: '', data_evidence: '', is_valid_issue: 'Partial' }, exclusion_reason: { level_1: '', level_2: '' },
    },
  } };
}

test('trusted log truncations reach analyzer prompts and rendered reports without reminder tags', () => {
  const { prepareLongDialogue } = require('../nodes/Long_Dialogue_Preflight/jsCode');
  const { renderSummaryMarkdown } = require('../../ai_summary_v3_AISummaryV3A0001/nodes/Render_Summary_Markdown/jsCode');
  const input = incidentInput('single_stream_full');
  for (const detail of input.aggregateData[0].details.filter((detail) => Array.isArray(detail.logs))) {
    detail.logs = Array.from({ length: 100 }, (_, index) => ({ index, text: 'x'.repeat(12000) }));
  }
  const scope = buildAnalysisScope(input);
  const prepared = prepareLongDialogue(input)[0];
  for (const name of ['Streamer_Log_Analyzer', 'Event_Log_Analyzer']) {
    const prompt = render(byName(name).parameters.text, input.analysisMode, prepared.aggregateData, '', input.analysisScope);
    assert.match(prompt, /<system-reminder>/);
    assert.match(prompt, /retained the last/);
  }
  const modelOutput = validReport(scope);
  const result = validateInferenceReport([{ output: modelOutput }], scope, prepared.logTruncations);
  const markdown = renderSummaryMarkdown(result.output, 'complete');
  for (const entry of prepared.logTruncations) {
    assert.ok(markdown.includes(entry.type));
    assert.ok(markdown.includes(entry.liveStreamID));
    assert.ok(markdown.includes(`省略前段 ${entry.omittedCount} 筆`));
  }
  assert.doesNotMatch(markdown, /system-reminder/);
  assert.equal(modelOutput.report.subjective_motivation.timeline_overview, 'Provided streams');
});

test('incident IDs and roles reach every analyzer and model focus cannot replace the request', () => {
  for (const mode of [undefined, 'single_stream_full']) {
    const input = incidentInput(mode);
    const scope = buildAnalysisScope(input);
    const prompt = render(byName('AI Agent').parameters.text, mode, input.aggregateData, '', input.analysisScope);
    for (const stream of scope.requestedStreams) assert.ok(prompt.includes(stream.liveStreamID));
    assert.ok(prompt.includes(JSON.stringify(scope)));
    for (const name of ['Dialogue_Analyzer', 'Streamer_Log_Analyzer', 'Event_Log_Analyzer', 'StreamInfo_Analyzer']) {
      const payload = JSON.parse(render(byName(name).parameters.text, mode, input.aggregateData,
        '請分析 liveStreamID 1: 103002308, liveStreamID 2: 103004376', input.analysisScope));
      assert.deepEqual(payload.analysisScope, scope);
      assert.equal(payload.analysisFocus, '');
      assert.doesNotMatch(JSON.stringify(payload), /103002308|103004376/);
      assert.deepEqual(payload.data.map((detail) => detail.liveStreamID), scope.availableStreamIDs);
    }
  }
});

test('partial dialogue and missing stream evidence retain comparison intent and requested roles', () => {
  const input = incidentInput();
  input.aggregateData[0].details = [];
  input.analysisScope.coverageStatus = 'partial';
  input.analysisScope.missingDialogueRoles = ['previous'];
  const scope = buildAnalysisScope(input);
  assert.equal(scope.analysisMode, 'comparison');
  assert.deepEqual(scope.requestedStreams.map((stream) => stream.liveStreamID), ['215320756', '215321109']);
  assert.deepEqual(scope.availableStreamIDs, ['215321109']);
  assert.deepEqual(scope.missingDialogueRoles, ['previous']);
  const output = validReport(scope);
  assert.deepEqual(validateInferenceReport([{ output }], scope), { output });
});

test('scope rejects contradictory inputs, wrong IDs, roles, mode, and absent structured output', () => {
  const input = incidentInput();
  const scope = buildAnalysisScope(input);
  for (const change of [
    (scope) => { scope.requestedStreams[0].liveStreamID = '103002308'; },
    (scope) => { scope.requestedStreams[0].role = 'current'; },
    (scope) => { scope.analysisMode = 'single_stream_full'; },
    (scope) => { scope.availableStreamIDs = []; },
    (scope) => { scope.coverageStatus = 'partial'; },
  ]) {
    const output = validReport(scope);
    change(output.analysisScope);
    assert.throws(() => validateInferenceReport([{ output }], scope), /summary_analysis_scope_mismatch/);
  }
  const output = validReport(scope);
  delete output.analysisScope;
  assert.throws(() => validateInferenceReport([{ output }], scope), /summary_analysis_scope_mismatch/);
  input.aggregateData[0].details[0].liveStreamID = '103002308';
  assert.throws(() => buildAnalysisScope(input), /summary_analysis_scope_invalid/);
});

test('target-claim guard catches the incident sentence while allowing unrelated log IDs and metrics', () => {
  const scope = buildAnalysisScope(incidentInput());
  const output = validReport(scope);
  output.report.summary.other_issue = '用戶請求分析的 liveStreamID (103002308, 103004376) 與日誌中實際存在的 ID (215320756, 215321109) 不符。本報告是基於日誌中實際存在的 ID 進行分析。';
  assert.throws(() => validateInferenceReport([{ output }], scope), /summary_analysis_scope_mismatch/);
  output.report.summary.other_issue = '事件日誌內部 liveStreamID 16000141 不作為本次分析對象。PingMax 272ms，時間戳 1789287489。';
  assert.deepEqual(validateInferenceReport([{ output }], scope), { output });
  output.report.summary.other_issue = '用戶請求分析 liveStreamID 215320756、215321109。';
  assert.deepEqual(validateInferenceReport([{ output }], scope), { output });
  output.report.summary.other_issue = '用戶請求分析 liveStreamID 1: 215320756, liveStreamID 2: 215321109；日誌內部 liveStreamID 16000141。';
  assert.deepEqual(validateInferenceReport([{ output }], scope), { output });
});

test('V2 and evaluation callers remain compatible without a new input field', () => {
  for (const folder of ['ai_summary_v2_FCaONjqNFA8YieKr', 'ai_summary_prompt_eval_fcJRfCDLAf8LBvXK']) {
    const caller = buildWorkflow(path.resolve(root, '..', folder));
    const node = caller.nodes.find((node) => node.parameters.workflowId?.value === workflow.id);
    assert.ok(node.parameters.workflowInputs.value.aggregateData);
    const legacyInput = { aggregateData: aggregate() };
    const scope = buildAnalysisScope(legacyInput);
    assert.equal(scope.analysisMode, 'comparison');
    assert.equal(scope.coverageStatus, 'unknown');
    const output = validReport(scope);
    assert.deepEqual(validateInferenceReport([{ output }], scope), { output });
  }
});
