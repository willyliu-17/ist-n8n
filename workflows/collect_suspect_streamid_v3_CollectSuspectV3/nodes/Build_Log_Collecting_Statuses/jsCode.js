const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d{6}$/;

function requireMessageTimestamp(response, label) {
  const timestamp = response?.message_timestamp;
  if (typeof timestamp !== 'string') throw new Error(`${label} Slack message timestamp is invalid`);
  if (!SLACK_TIMESTAMP_PATTERN.test(timestamp)) throw new Error(`${label} Slack message timestamp is invalid`);
  return timestamp;
}

function buildLogCollectingStatuses(requests, processingResponses) {
  const eligible = (requests || []).filter(({ stream }) => stream?.sttEligible !== false);
  if (eligible.length !== (processingResponses || []).length) throw new Error('Processing message count mismatch');
  eligible.forEach((request, index) => requireMessageTimestamp(processingResponses[index], `Processing message ${index}`));

  const byCandidate = new Map();
  for (const { candidate, stream } of eligible) {
    if (!byCandidate.has(candidate.candidateKey)) {
      byCandidate.set(candidate.candidateKey, {
        candidateKey: candidate.candidateKey,
        channel: candidate.channel,
        threadTS: candidate.threadTS,
        streamIDs: [],
      });
    }
    byCandidate.get(candidate.candidateKey).streamIDs.push(String(stream.liveStreamID));
  }

  return [...byCandidate.values()].map((status) => ({
    ...status,
    logStatusText: `Collecting stream logs for ${status.streamIDs.map((streamID) => `\`${streamID}\``).join(', ')}. Attachments will follow below.`,
  }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildLogCollectingStatuses, requireMessageTimestamp };
}

if (typeof $input !== 'undefined') {
  const requests = $('Reassemble Resolver Output').all().map(({ json }) => json).filter(({ stream }) => stream);
  return buildLogCollectingStatuses(requests, $input.all().map(({ json }) => json)).map((json) => ({ json }));
}
