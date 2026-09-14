const DIRECT_BUDGET_BYTES = 128 * 1024;
const CHUNK_BUDGET_BYTES = 32 * 1024;
const MAX_CHUNKS = 12;
const MAP_OUTPUT_BUDGET_BYTES = 8 * 1024;
const MAP_OUTPUT_RESERVE_BYTES = (MAP_OUTPUT_BUDGET_BYTES * 2) + 512;
const COVERAGE_RESERVE_BYTES = 2048;
const KNOWN_MAIN_MODELS = new Set(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-pro-preview']);

function buildAnalysisScope(input) {
  const fail = () => { throw new Error('summary_analysis_scope_invalid'); };
  const aggregate = input.aggregateData || [];
  if (!Array.isArray(aggregate)) fail();
  const mode = input.analysisMode === 'single_stream_full' ? 'single_stream_full' : 'comparison';
  if (![undefined, null, '', 'legacy', 'single_stream_full'].includes(input.analysisMode)) fail();
  const supplied = input.analysisScope;
  if (supplied != null && (typeof supplied !== 'object' || Array.isArray(supplied))) fail();
  const identity = (stream) => {
    if (!stream || !/^[1-9]\d*$/.test(String(stream.liveStreamID || ''))) fail();
    const role = stream.role || 'unspecified';
    if (!['previous', 'current', 'unspecified'].includes(role)) fail();
    return { liveStreamID: String(stream.liveStreamID), role };
  };
  const present = aggregate.map((stream) => {
    if (!stream || !Array.isArray(stream.details)) fail();
    const dialogue = stream.details.find((detail) => detail?.type === 'dialogue');
    const declared = Array.isArray(supplied?.requestedStreams) ? supplied.requestedStreams.find((target) => String(target?.liveStreamID) === String(stream.liveStreamID)) : null;
    const result = identity({ liveStreamID: stream.liveStreamID, role: dialogue?.role || declared?.role });
    for (const detail of stream.details) {
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) fail();
      if (detail?.liveStreamID != null && String(detail.liveStreamID) !== result.liveStreamID) fail();
    }
    return result;
  });
  const requested = supplied?.requestedStreams ?? present;
  if (!Array.isArray(requested)) fail();
  const requestedStreams = requested.map(identity);
  const ids = requestedStreams.map((stream) => stream.liveStreamID);
  if (new Set(ids).size !== ids.length || new Set(present.map((stream) => stream.liveStreamID)).size !== present.length) fail();
  const roles = requestedStreams.map((stream) => stream.role).filter((role) => role !== 'unspecified');
  if (new Set(roles).size !== roles.length) fail();
  if (mode === 'single_stream_full' && (requestedStreams.length !== 1 || present.length !== 1)) fail();
  if (present.some((stream) => !requestedStreams.some((target) => target.liveStreamID === stream.liveStreamID && target.role === stream.role))) fail();
  const missingDialogueRoles = supplied?.missingDialogueRoles ?? [];
  if (!Array.isArray(missingDialogueRoles) || new Set(missingDialogueRoles).size !== missingDialogueRoles.length
    || missingDialogueRoles.some((role) => !roles.includes(role))) fail();
  const coverageStatus = supplied?.coverageStatus ?? 'unknown';
  if (!['complete', 'partial', 'unknown'].includes(coverageStatus)
    || coverageStatus === 'complete' && (missingDialogueRoles.length || present.length !== ids.length)
    || coverageStatus === 'partial' && !missingDialogueRoles.length) fail();
  const availableStreamIDs = present.filter((stream, index) => aggregate[index].details.some((detail) => {
    if (detail.type === 'dialogue') return typeof detail.dialogue === 'string' && detail.dialogue.trim() !== '';
    if (detail.type === 'streamInfo') return Array.isArray(detail.streamInfo) && detail.streamInfo.some((info) => info && Object.keys(info).length > 0);
    return ['streamerLog', 'streamEventLog'].includes(detail.type) && Array.isArray(detail.logs) && detail.logs.length > 0;
  })).map((stream) => stream.liveStreamID);
  return { analysisMode: mode, requestedStreams, availableStreamIDs, missingDialogueRoles, coverageStatus };
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function latestTimestamp(text) {
  const matches = text.match(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g);
  return matches ? matches[matches.length - 1] : '';
}

function safeCut(text, start, maxBytes) {
  let end = start;
  let bytes = 0;
  while (end < text.length) {
    const point = text.codePointAt(end);
    const width = point > 0xffff ? 2 : 1;
    const pointBytes = utf8Bytes(text.slice(end, end + width));
    if (bytes + pointBytes > maxBytes) break;
    bytes += pointBytes;
    end += width;
  }
  if (end === start) throw new Error('dialogue contains a code point larger than the chunk payload budget');
  const floor = Math.max(start, end - Math.min(1024, end - start));
  for (let cursor = end; cursor > floor; cursor -= 1) {
    if (/\s/.test(text[cursor - 1])) return cursor;
  }
  return end;
}

function chunkDialogue(dialogue) {
  const chunks = [];
  let start = 0;
  while (start < dialogue.length) {
    const timestampContext = latestTimestamp(dialogue.slice(Math.max(0, start - 256), start));
    const header = `[source chunk ${chunks.length + 1}; chars ${start}-`;
    const reserve = utf8Bytes(header) + 32 + utf8Bytes(`; timestamp context ${timestampContext || 'unavailable'}]\n`);
    const end = safeCut(dialogue, start, CHUNK_BUDGET_BYTES - reserve);
    const chunkText = `${header}${end}; timestamp context ${timestampContext || 'unavailable'}]\n${dialogue.slice(start, end)}`;
    if (utf8Bytes(chunkText) > CHUNK_BUDGET_BYTES) throw new Error('chunk payload budget exceeded');
    chunks.push({ chunkIndex: chunks.length, startChar: start, endChar: end, sourceCharLength: dialogue.length, timestampContext, chunkText });
    start = end;
    if (chunks.length > MAX_CHUNKS) throw new Error(`dialogue requires more than ${MAX_CHUNKS} chunks; refusing unbounded map cost`);
  }
  return chunks;
}

function locateDialogue(aggregateData) {
  if (!Array.isArray(aggregateData) || aggregateData.length !== 1) throw new Error('single_stream_full requires exactly one aggregate stream');
  const stream = aggregateData[0];
  const liveStreamID = String(stream && stream.liveStreamID || '').trim();
  if (!/^[1-9]\d*$/.test(liveStreamID)) throw new Error('single_stream_full requires one numeric liveStreamID');
  const details = stream && stream.details;
  const matches = Array.isArray(details) ? details.filter((detail) => detail && detail.type === 'dialogue') : [];
  if (matches.length !== 1 || String(matches[0].liveStreamID || '').trim() !== liveStreamID || typeof matches[0].dialogue !== 'string') throw new Error('single_stream_full requires one matching dialogue detail');
  return matches[0];
}

function prepareLongDialogue(input) {
  const aggregateData = Array.isArray(input.aggregateData) ? input.aggregateData : [];
  const analysisMode = input.analysisMode;
  if (analysisMode === undefined || analysisMode === null || analysisMode === '' || analysisMode === 'legacy') return [{ aggregateData, useChunks: false }];
  if (analysisMode !== 'single_stream_full') throw new Error('unknown analysisMode');
  const modelName = input.evalConfig && input.evalConfig.modelName;
  if (modelName && !KNOWN_MAIN_MODELS.has(modelName)) throw new Error('single_stream_full rejects an unknown evalConfig.modelName');
  const dialogue = locateDialogue(aggregateData);
  if (utf8Bytes(JSON.stringify(aggregateData)) <= DIRECT_BUDGET_BYTES) return [{ aggregateData, useChunks: false }];
  if (dialogue.dialogue.length === 0) throw new Error('single_stream_full cannot map an empty dialogue when the aggregate exceeds the payload budget');
  const baseAggregate = clone(aggregateData);
  const baseDialogue = locateDialogue(baseAggregate);
  baseDialogue.dialogue = '';
  if (utf8Bytes(JSON.stringify(baseAggregate)) > DIRECT_BUDGET_BYTES) throw new Error('non-dialogue aggregate payload exceeds the 128KB payload budget');

  const chunks = chunkDialogue(dialogue.dialogue);
  const worstCaseMergedBytes = utf8Bytes(JSON.stringify(baseAggregate)) + COVERAGE_RESERVE_BYTES + (chunks.length * MAP_OUTPUT_RESERVE_BYTES);
  if (worstCaseMergedBytes > DIRECT_BUDGET_BYTES) throw new Error('map/reduce aggregate payload budget cannot reserve all chunk evidence');
  return chunks.map((chunk, index) => ({
    ...chunk,
    useChunks: true,
    totalChunks: chunks.length,
    ...(index === 0 ? { baseAggregate } : {}),
  }));
}

if (typeof module !== 'undefined') module.exports = { CHUNK_BUDGET_BYTES, DIRECT_BUDGET_BYTES, MAP_OUTPUT_BUDGET_BYTES, MAX_CHUNKS, buildAnalysisScope, chunkDialogue, prepareLongDialogue, safeCut, utf8Bytes };
if (typeof $input !== 'undefined') {
  const inputs = $input.all();
  const fullStreamInputs = inputs.filter((item) => item.json && item.json.analysisMode === 'single_stream_full');
  if (fullStreamInputs.length > 0) {
    if (inputs.length !== 1 || fullStreamInputs.length !== 1) throw new Error('single_stream_full requires exactly one workflow input item');
    const analysisScope = buildAnalysisScope(inputs[0].json);
    return prepareLongDialogue(inputs[0].json).map((json) => ({ json: { ...json, analysisScope }, pairedItem: { item: 0 } }));
  }
  return inputs.flatMap((item, inputIndex) => {
    const analysisScope = buildAnalysisScope(item.json);
    return prepareLongDialogue(item.json).map((json) => ({ json: { ...json, analysisScope }, pairedItem: { item: inputIndex } }));
  });
}
