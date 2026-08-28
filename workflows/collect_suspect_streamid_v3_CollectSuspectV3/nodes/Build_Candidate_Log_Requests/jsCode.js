const CHANNEL = 'C0A4JJJKJMD';
const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d{6}$/;
const STREAM_ID_PATTERN = /^[0-9]{1,20}$/;

function requiredStreamID(value, fieldName) {
  const streamID = String(value ?? '').trim();
  if (!STREAM_ID_PATTERN.test(streamID)) throw new Error(`${fieldName} must be a numeric stream ID`);
  return streamID;
}

function buildCandidateLogRequests(candidates) {
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array');
  const requests = [];
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate?.id) || candidate.id <= 0
      || candidate.action !== 'ready'
      || candidate.reconciliationStatus !== 'canonical'
      || candidate.canonicalRowID !== String(candidate.id)) {
      throw new Error('Only a checkpointed canonical candidate can query logs');
    }
    if (candidate.channel !== CHANNEL) throw new Error('Candidate channel is not allowed');
    if (!SLACK_TIMESTAMP_PATTERN.test(candidate.threadTS || '')) throw new Error('Candidate thread timestamp is invalid');

    const target_thread_ts = candidate.threadTS;
    if (candidate.prevStreamID) {
      requests.push({
        streamID: requiredStreamID(candidate.prevStreamID, 'prevStreamID'),
        channel: CHANNEL,
        target_thread_ts,
      });
    }
    requests.push({
      streamID: requiredStreamID(candidate.streamID, 'streamID'),
      channel: CHANNEL,
      target_thread_ts,
    });
  }
  return requests;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildCandidateLogRequests };
}

if (typeof $input !== 'undefined') {
  return buildCandidateLogRequests($input.all().map(({ json }) => json)).map((json) => ({ json }));
}
