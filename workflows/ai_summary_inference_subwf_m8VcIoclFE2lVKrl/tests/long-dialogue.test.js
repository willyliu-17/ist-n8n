const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflow.json'), 'utf8'));
const { CHUNK_BUDGET_BYTES, DIRECT_BUDGET_BYTES, MAX_CHUNKS, prepareLongDialogue, utf8Bytes } = require('../nodes/Long_Dialogue_Preflight/jsCode');
const { END_MARKER, MAP_OUTPUT_BUDGET_BYTES, collectChunkEvidence } = require('../nodes/Collect_Dialogue_Chunk_Evidence/jsCode');

function aggregate(dialogue = 'short dialogue') {
  return [{ liveStreamID: '123', details: [{ type: 'dialogue', liveStreamID: '123', dialogue, transcript: { outcome: 'transcribed' } }], count: 1 }];
}

function longDialogue() {
  return Array.from({ length: 4500 }, (_, index) => `[12:${String(index % 60).padStart(2, '0')}:00] [streamer]: text ${index}\n`).join('');
}

function chainText(value) {
  return { json: { text: `${value}\n${END_MARKER}` } };
}

function runRuntime(file, context) {
  const source = fs.readFileSync(file, 'utf8');
  return vm.runInNewContext(`(function () { ${source} })()`, { Buffer, ...context });
}

test('legacy accepts only its explicit modes and preserves exact aggregate data', () => {
  const data = aggregate('legacy');
  assert.deepEqual(prepareLongDialogue({ aggregateData: data })[0], { aggregateData: data, useChunks: false });
  assert.deepEqual(prepareLongDialogue({ aggregateData: data, analysisMode: 'legacy' })[0], { aggregateData: data, useChunks: false });
  assert.throws(() => prepareLongDialogue({ aggregateData: data, analysisMode: 'unknown' }), /unknown analysisMode/);
});

test('single_stream_full validates one numeric stream and matching dialogue before direct budgeting', () => {
  const data = aggregate('small');
  assert.deepEqual(prepareLongDialogue({ aggregateData: data, analysisMode: 'single_stream_full' })[0], { aggregateData: data, useChunks: false });
  assert.throws(() => prepareLongDialogue({ aggregateData: [data[0], data[0]], analysisMode: 'single_stream_full' }), /exactly one aggregate/);
  assert.throws(() => prepareLongDialogue({ aggregateData: [{ ...data[0], liveStreamID: 'id' }], analysisMode: 'single_stream_full' }), /numeric liveStreamID/);
  assert.throws(() => prepareLongDialogue({ aggregateData: [{ ...data[0], details: [{ type: 'dialogue', liveStreamID: '999', dialogue: 'x' }] }], analysisMode: 'single_stream_full' }), /matching dialogue/);
  const empty = aggregate('');
  assert.deepEqual(prepareLongDialogue({ aggregateData: empty, analysisMode: 'single_stream_full' })[0], { aggregateData: empty, useChunks: false });
});

test('unicode chunks cover all characters without splitting a surrogate pair', () => {
  const emoji = String.fromCodePoint(0x1f600);
  const dialogue = `${'x'.repeat(CHUNK_BUDGET_BYTES - 100)}${emoji}${'x'.repeat(DIRECT_BUDGET_BYTES - CHUNK_BUDGET_BYTES)}`;
  const chunks = prepareLongDialogue({ aggregateData: aggregate(dialogue), analysisMode: 'single_stream_full' });
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].startChar, 0);
  assert.equal(chunks.at(-1).endChar, dialogue.length);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    assert.ok(utf8Bytes(chunk.chunkText) <= CHUNK_BUDGET_BYTES);
    for (const boundary of [chunk.startChar, chunk.endChar]) {
      if (boundary > 0 && boundary < dialogue.length) {
        const left = dialogue.charCodeAt(boundary - 1);
        const right = dialogue.charCodeAt(boundary);
        assert.equal(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff, false);
      }
    }
    if (index) assert.equal(chunk.startChar, chunks[index - 1].endChar);
  }
});

test('timestamp context uses only the timestamp before the chunk boundary', () => {
  const dialogue = `${'x'.repeat(CHUNK_BUDGET_BYTES - 300)}[01:00:00] [streamer]: old\n${'x'.repeat(DIRECT_BUDGET_BYTES)}\n[02:00:00] [streamer]: future`;
  const chunks = prepareLongDialogue({ aggregateData: aggregate(dialogue), analysisMode: 'single_stream_full' });
  assert.equal(chunks[0].timestampContext, '');
  assert.equal(chunks[1].timestampContext, '[01:00:00]');
});

test('collector uses trusted source mappings and ChainLLM text outputs', () => {
  const sourceChunks = prepareLongDialogue({ aggregateData: aggregate(longDialogue()), analysisMode: 'single_stream_full' });
  const results = sourceChunks.map((_, item) => chainText(`evidence ${item}`)).reverse();
  const output = collectChunkEvidence(results, [...sourceChunks].reverse());
  const detail = output.aggregateData[0].details[0];
  assert.equal(detail.dialogueCoverage.completedChunks, sourceChunks.length);
  assert.match(detail.dialogue, /evidence 0/);
});

test('collector fails closed for empty, duplicate, missing, and oversized results', () => {
  const sources = prepareLongDialogue({ aggregateData: aggregate(longDialogue()), analysisMode: 'single_stream_full' });
  const valid = sources.map((_, item) => chainText(`evidence ${item}`));
  assert.throws(() => collectChunkEvidence([{ json: { text: '' } }, ...valid.slice(1)], sources), /non-empty/);
  assert.throws(() => collectChunkEvidence(valid, [{ ...sources[0] }, { ...sources[0] }, ...sources.slice(2)]), /duplicate/);
  assert.throws(() => collectChunkEvidence(valid.slice(1), sources), /count mismatch/);
  assert.throws(() => collectChunkEvidence([{ json: { text: 'x'.repeat(MAP_OUTPUT_BUDGET_BYTES + 1) } }, ...valid.slice(1)], sources), /8KB/);
  assert.throws(() => collectChunkEvidence([{ json: { text: 'evidence without marker' } }, ...valid.slice(1)], sources), /END_OF_CHUNK_EVIDENCE/);
  assert.throws(() => collectChunkEvidence(valid, sources.map((source, index) => index === 1 ? { ...source, startChar: source.startChar + 1 } : source)), /non-contiguous/);
});

test('preflight rejects non-dialogue payload overflow and unbounded chunk cost', () => {
  const baseline = aggregate('x');
  baseline[0].details.push({ type: 'streamerLog', logs: ['x'.repeat(DIRECT_BUDGET_BYTES)] });
  assert.throws(() => prepareLongDialogue({ aggregateData: baseline, analysisMode: 'single_stream_full' }), /non-dialogue aggregate/);
  assert.throws(() => prepareLongDialogue({ aggregateData: aggregate('x'.repeat(CHUNK_BUDGET_BYTES * (MAX_CHUNKS + 2))), analysisMode: 'single_stream_full' }), /payload budget|more than/);
});

test('runtime preflight preserves every legacy item and isolates single_stream_full', () => {
  const file = path.join(__dirname, '..', 'nodes', 'Long_Dialogue_Preflight', 'jsCode.js');
  const legacy = runRuntime(file, { $input: { all: () => [{ json: { aggregateData: aggregate('first') } }, { json: { aggregateData: aggregate('second'), analysisMode: 'legacy' } }] } });
  assert.equal(legacy.length, 2);
  assert.deepEqual(legacy.map((item) => item.pairedItem.item), [0, 1]);
  assert.deepEqual(legacy.map((item) => item.json.aggregateData[0].details[0].dialogue), ['first', 'second']);
  assert.throws(() => runRuntime(file, { $input: { all: () => [{ json: { aggregateData: aggregate('x'.repeat(DIRECT_BUDGET_BYTES)), analysisMode: 'single_stream_full' } }, { json: { aggregateData: aggregate('legacy') } }] } }), /exactly one workflow input item/);
});

test('runtime collector uses itemMatching mapping and ignores absent ChainLLM pairedItem', () => {
  const sources = prepareLongDialogue({ aggregateData: aggregate(longDialogue()), analysisMode: 'single_stream_full' });
  const results = sources.map((_, index) => chainText(`runtime ${index}`));
  const file = path.join(__dirname, '..', 'nodes', 'Collect_Dialogue_Chunk_Evidence', 'jsCode.js');
  const output = runRuntime(file, {
    $input: { all: () => results },
    $: () => ({ itemMatching: (index) => ({ json: sources[index] }) }),
  });
  assert.equal(output[0].json.aggregateData[0].details[0].dialogueCoverage.completedChunks, sources.length);
});

test('workflow pins a guarded chunk chain and direct bypass', () => {
  assert.equal(workflow.connections['Use Dialogue Chunks'].main[1][0].node, 'Aggregate');
  const map = workflow.nodes.find((node) => node.name === 'Map Dialogue Chunk Evidence');
  assert.match(map.parameters.messages.messageValues[0].message, /untrusted evidence/);
  assert.match(map.parameters.messages.messageValues[0].message, /complete IP address/);
  const model = workflow.nodes.find((node) => node.name === 'Vertex Gemini-2.5-flash Chunk Map');
  assert.equal(model.parameters.modelName, 'gemini-2.5-flash');
  assert.equal(model.parameters.options.maxOutputTokens, 2048);
  const preflight = fs.readFileSync(path.join(__dirname, '..', 'nodes', 'Long_Dialogue_Preflight', 'jsCode.js'), 'utf8');
  const collector = fs.readFileSync(path.join(__dirname, '..', 'nodes', 'Collect_Dialogue_Chunk_Evidence', 'jsCode.js'), 'utf8');
  assert.match(preflight, /pairedItem: \{ item: 0 \}/);
  assert.match(collector, /itemMatching\(index\)/);
  assert.match(collector, /item\.json\.text/);
  assert.match(collector, /END_OF_CHUNK_EVIDENCE/);
  assert.doesNotMatch(collector, /readPairedIndex/);
});

test('trusted analysis scope survives both direct and chunked runtime paths', () => {
  const file = path.join(__dirname, '..', 'nodes', 'Long_Dialogue_Preflight', 'jsCode.js');
  for (const dialogue of ['short', longDialogue()]) {
    const input = { aggregateData: aggregate(dialogue), analysisMode: 'single_stream_full' };
    const prepared = runRuntime(file, { $input: { all: () => [{ json: input }] } });
    for (const item of prepared) {
      assert.equal(item.json.analysisScope.analysisMode, 'single_stream_full');
      assert.equal(item.json.analysisScope.requestedStreams[0].liveStreamID, '123');
      assert.equal(item.json.analysisScope.availableStreamIDs[0], '123');
    }
    if (prepared[0].json.useChunks) {
      const results = prepared.map((_, index) => chainText(`evidence ${index}`));
      const collected = collectChunkEvidence(results, prepared.map((item) => item.json));
      assert.equal(collected.aggregateData[0].liveStreamID, prepared[0].json.analysisScope.requestedStreams[0].liveStreamID);
    }
  }
});
