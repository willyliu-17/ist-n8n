const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d{6}$/;

function checkpointCarrierKey(candidateKey, channel, threadTS) {
  return `${candidateKey}:${channel}:${threadTS}`;
}

function buildOrchestratorRequests(requests, messageRows, checkpoints = []) {
  const eligibleRequests = requests.filter(({ stream }) => stream && stream.sttEligible !== false);
  if (eligibleRequests.length !== messageRows.length) throw new Error('Processing message count mismatch');
  const processingMessages = new Map();
  eligibleRequests.forEach((request, index) => {
    const processingMessageTS = messageRows[index]?.message_timestamp;
    if (typeof processingMessageTS !== 'string') throw new Error('Invalid persisted processing message timestamp');
    if (!SLACK_TIMESTAMP_PATTERN.test(processingMessageTS || '')) throw new Error('Invalid persisted processing message timestamp');
    processingMessages.set(request, processingMessageTS);
  });

  const grouped = new Map();
  for (const request of requests.filter(({ stream }) => stream)) {
    const key = request.candidate.summaryRequestKey;
    if (!grouped.has(key)) grouped.set(key, { candidate: request.candidate, streams: [], eligibleCount: 0 });
    const group = grouped.get(key);
    const processingMessageTS = processingMessages.get(request);
    group.streams.push({
      ...request.stream,
      ...(processingMessageTS ? { processingMessageTS } : {}),
    });
    if (request.stream.sttEligible !== false) group.eligibleCount += 1;
  }

  const output = [...grouped.values()]
    .filter(({ eligibleCount }) => eligibleCount > 0)
    .map(({ candidate, streams }) => ({
      requestKey: candidate.summaryRequestKey,
      requestType: 'suspect_summary',
      orderedStreams: streams,
      existingDialogues: {},
      channel: candidate.channel,
      threadTS: candidate.threadTS,
    }));
  const expectedCheckpointKeys = new Set(output.map(({ requestKey, channel, threadTS }) => {
    const candidate = grouped.get(requestKey)?.candidate;
    if (typeof candidate?.candidateKey !== 'string' || !candidate.candidateKey) {
      throw new Error('Orchestrator request candidate identity is invalid');
    }
    return checkpointCarrierKey(candidate.candidateKey, channel, threadTS);
  }));
  const checkpointKeys = new Set();
  for (const envelope of checkpoints) {
    const carrier = envelope?.carrier;
    const checkpoint = envelope?.checkpoint;
    const candidateKey = carrier?.candidateKey;
    const channel = carrier?.channel;
    const threadTS = carrier?.threadTS;
    const messageTimestamp = checkpoint?.messageTimestamp;
    const responseThreadTS = checkpoint?.responseThreadTS;
    if (typeof candidateKey !== 'string' || !candidateKey
      || typeof channel !== 'string' || !channel
      || typeof threadTS !== 'string' || !SLACK_TIMESTAMP_PATTERN.test(threadTS)
      || checkpoint?.channel !== channel
      || typeof messageTimestamp !== 'string' || !SLACK_TIMESTAMP_PATTERN.test(messageTimestamp)
      || (responseThreadTS !== undefined && responseThreadTS !== threadTS)) {
      throw new Error('Log collecting status checkpoint is invalid');
    }
    const key = checkpointCarrierKey(candidateKey, channel, threadTS);
    if (checkpointKeys.has(key)) throw new Error('Duplicate log collecting status checkpoint');
    checkpointKeys.add(key);
  }
  if (checkpointKeys.size !== expectedCheckpointKeys.size
    || [...checkpointKeys].some((key) => !expectedCheckpointKeys.has(key))) {
    throw new Error('Log collecting status checkpoint does not match orchestrator request');
  }
  return output;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildOrchestratorRequests };
}

if (typeof $input !== 'undefined') {
  const inputRows = $input.all().map(({ json }) => json);
  if (!inputRows.every(({ carrier, checkpoint }) => carrier && checkpoint)) {
    throw new Error('Build Orchestrator Requests requires log collecting status checkpoints');
  }
  const requests = $('Reassemble Resolver Output').all()
    .map(({ json }) => json)
    .filter(({ stream }) => stream);
  const processingRows = $('Send Processing Message').all().map(({ json }) => json);
  return buildOrchestratorRequests(requests, processingRows, inputRows).map((json) => ({ json }));
}
