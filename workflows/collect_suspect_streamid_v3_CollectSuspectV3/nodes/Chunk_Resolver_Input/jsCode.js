const MAX_CHUNK_SIZE = 100;

function chunkIDs(ids, size = MAX_CHUNK_SIZE) {
  if (!Number.isInteger(size) || size < 1 || size > MAX_CHUNK_SIZE) throw new Error('chunk size must be 1..100');
  const unique = [...new Set((ids || []).map((value) => String(value).trim()).filter(Boolean))];
  return Array.from({ length: Math.ceil(unique.length / size) }, (_, index) => unique.slice(index * size, (index + 1) * size));
}

function defaultLookupWindow(nowMs = Date.now()) {
  return {
    start: new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString(),
    end: new Date(nowMs).toISOString(),
  };
}

function buildResolverCalls({ positions, lookupWindow } = {}) {
  if (!Array.isArray(positions)) throw new Error('positions must be an array');
  const ids = positions.map(({ liveStreamID }) => String(liveStreamID));
  return chunkIDs(ids).map((chunk, chunkIndex) => ({
    chunkIndex,
    streams: chunk.map((liveStreamID) => ({ liveStreamID })),
    lookupWindow: lookupWindow || defaultLookupWindow(),
    profile: 'stt',
  }));
}

function candidatePositions(candidate) {
  const positions = [];
  if (candidate.prevStreamID) positions.push({ originalIndex: 0, role: 'previous', liveStreamID: candidate.prevStreamID, mode: 'fromEnd' });
  positions.push({ originalIndex: positions.length, role: 'current', liveStreamID: candidate.streamID, mode: 'fromStart' });
  return positions;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MAX_CHUNK_SIZE, buildResolverCalls, chunkIDs, defaultLookupWindow };
}

if (typeof $input !== 'undefined') {
  const output = [];
  for (const { json: candidate } of $input.all()) {
    if (!Number.isSafeInteger(candidate.id) || candidate.id <= 0 || candidate.action !== 'ready' || candidate.reconciliationStatus !== 'canonical' || candidate.canonicalRowID !== String(candidate.id)) {
      throw new Error('Only a verified canonical candidate can resolve metadata');
    }
    const positions = candidatePositions(candidate);
    const calls = buildResolverCalls({ positions });
    for (const call of calls) output.push({ json: { ...call, candidate, positions } });
  }
  return output;
}
