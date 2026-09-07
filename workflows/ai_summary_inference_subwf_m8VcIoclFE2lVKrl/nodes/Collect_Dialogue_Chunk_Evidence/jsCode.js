const MERGED_BUDGET_BYTES = 128 * 1024;
const MAP_OUTPUT_BUDGET_BYTES = 8 * 1024;
const END_MARKER = 'END_OF_CHUNK_EVIDENCE';

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readEvidence(item) {
  const text = item && item.json && item.json.text;
  if (typeof text !== 'string' || text.trim() === '') throw new Error('chunk result has no non-empty Basic LLM Chain text output');
  if (utf8Bytes(text) > MAP_OUTPUT_BUDGET_BYTES) throw new Error('chunk map output exceeds the 8KB payload budget');
  const trimmed = text.trim();
  if (!trimmed.endsWith(END_MARKER)) throw new Error('chunk map output is missing END_OF_CHUNK_EVIDENCE');
  const evidence = trimmed.slice(0, -END_MARKER.length).trim();
  if (!evidence) throw new Error('chunk map output contains no evidence before END_OF_CHUNK_EVIDENCE');
  return evidence;
}

function verifySourceChunks(sourceChunks) {
  if (!Array.isArray(sourceChunks) || sourceChunks.length === 0) throw new Error('chunk verifier requires source chunks');
  const seenIndexes = new Set();
  for (const chunk of sourceChunks) {
    if (!chunk || !Number.isInteger(chunk.chunkIndex) || seenIndexes.has(chunk.chunkIndex)) throw new Error('trusted source chunks contain a duplicate or invalid chunk index');
    seenIndexes.add(chunk.chunkIndex);
  }
  const ordered = [...sourceChunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
  const sourceCharLength = ordered[0] && ordered[0].sourceCharLength;
  if (!Number.isInteger(sourceCharLength) || sourceCharLength < 0) throw new Error('trusted source chunks require sourceCharLength');
  let expectedStart = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const chunk = ordered[index];
    if (!chunk || chunk.chunkIndex !== index || chunk.totalChunks !== ordered.length || chunk.sourceCharLength !== sourceCharLength || !Number.isInteger(chunk.startChar) || !Number.isInteger(chunk.endChar) || chunk.startChar !== expectedStart || chunk.endChar <= chunk.startChar) throw new Error('trusted source chunk ranges are incomplete or non-contiguous');
    expectedStart = chunk.endChar;
  }
  if (expectedStart !== sourceCharLength) throw new Error('trusted source chunk ranges do not cover the original dialogue');
  return ordered;
}

function collectChunkEvidence(results, matchedSourceChunks) {
  const sourceChunks = matchedSourceChunks;
  const orderedSources = verifySourceChunks(sourceChunks);
  const first = orderedSources[0];
  if (!first || !Array.isArray(first.baseAggregate)) throw new Error('chunk verifier requires the first source chunk carrier');
  if (results.length !== sourceChunks.length) throw new Error(`chunk result count mismatch: expected ${sourceChunks.length}, received ${results.length}`);

  const received = new Map();
  for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
    const source = sourceChunks[resultIndex];
    if (!source || !Number.isInteger(source.chunkIndex) || source.chunkIndex < 0 || source.chunkIndex >= sourceChunks.length || received.has(source.chunkIndex)) throw new Error('chunk result has a duplicate or out-of-range trusted source chunk link');
    received.set(source.chunkIndex, { source, evidence: readEvidence(results[resultIndex]) });
  }
  if (received.size !== sourceChunks.length) throw new Error('chunk results are incomplete');

  const aggregateData = clone(first.baseAggregate);
  const details = aggregateData[0] && aggregateData[0].details;
  const dialogue = Array.isArray(details) && details.find((detail) => detail && detail.type === 'dialogue');
  if (!dialogue) throw new Error('chunk verifier cannot restore the dialogue detail');
  const ordered = [...received.values()].sort((left, right) => left.source.chunkIndex - right.source.chunkIndex);
  const evidence = ordered.map(({ source, evidence: text }) => `[source chunk ${source.chunkIndex + 1}/${sourceChunks.length}; chars ${source.startChar}-${source.endChar}; timestamp context ${source.timestampContext || 'unavailable'}]\n${text}`);
  dialogue.dialogue = evidence.join('\n\n');
  dialogue.dialogueCoverage = {
    kind: 'chunked_evidence',
    totalChunks: sourceChunks.length,
    completedChunks: received.size,
    sourceCharRanges: ordered.map(({ source }) => ({ chunkIndex: source.chunkIndex, startChar: source.startChar, endChar: source.endChar, timestampContext: source.timestampContext || null })),
    overlapChars: 0,
    payloadBudget: 'UTF-8 byte budget, not an exact token count',
  };
  if (utf8Bytes(JSON.stringify(aggregateData)) > MERGED_BUDGET_BYTES) throw new Error('merged map/reduce aggregate exceeds the 128KB payload budget');
  return { aggregateData, useChunks: false };
}

if (typeof module !== 'undefined') module.exports = { END_MARKER, MAP_OUTPUT_BUDGET_BYTES, MERGED_BUDGET_BYTES, collectChunkEvidence, readEvidence, utf8Bytes, verifySourceChunks };
if (typeof $input !== 'undefined') {
  const results = $input.all();
  const matchedSourceChunks = results.map((_, index) => $('Long Dialogue Preflight').itemMatching(index).json);
  return [{ json: collectChunkEvidence(results, matchedSourceChunks) }];
}
