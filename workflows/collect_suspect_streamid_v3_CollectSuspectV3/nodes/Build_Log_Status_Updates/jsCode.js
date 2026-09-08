const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d{6}$/;

function carrierKey(channel, threadTS) {
  return `${channel}:${threadTS}`;
}

function summarizeByThread(results, expectedRequests) {
  const expectedByThread = new Map();
  for (const request of expectedRequests) {
    const threadTS = String(request.target_thread_ts || '');
    if (!expectedByThread.has(threadTS)) expectedByThread.set(threadTS, []);
    expectedByThread.get(threadTS).push(request);
  }
  const resultsByThread = new Map();
  for (const result of results) {
    const threadTS = String(result.target_thread_ts || '');
    if (expectedByThread.has(threadTS)) {
      if (!resultsByThread.has(threadTS)) resultsByThread.set(threadTS, []);
      resultsByThread.get(threadTS).push(result);
    }
  }
  return [...expectedByThread.entries()].map(([threadTS, expected]) => {
    const actual = resultsByThread.get(threadTS) || [];
    const expectedKeys = expected.map(({ streamID }) => String(streamID)).sort();
    const actualKeys = actual.map(({ streamID }) => String(streamID)).sort();
    const allSucceeded = actual.length === expected.length
      && actual.every(({ ok }) => ok === true)
      && actualKeys.every((streamID, index) => streamID === expectedKeys[index]);
    return {
      target_thread_ts: threadTS,
      expectedCount: expected.length,
      successCount: actual.filter(({ ok }) => ok === true).length,
      allSucceeded,
    };
  });
}

function buildLogStatusUpdates(results, expectedRequests, carriers, checkpoints) {
  const checkpointByCarrier = new Map();
  for (const envelope of checkpoints) {
    const carrier = envelope?.carrier;
    const checkpoint = envelope?.checkpoint;
    const candidateKey = carrier?.candidateKey;
    const channel = carrier?.channel;
    const threadTS = carrier?.threadTS;
    const ts = checkpoint?.messageTimestamp;
    if (typeof candidateKey !== 'string' || !candidateKey
      || typeof channel !== 'string' || typeof threadTS !== 'string'
      || checkpoint?.channel !== channel || typeof ts !== 'string' || !SLACK_TIMESTAMP_PATTERN.test(ts)
      || (checkpoint.responseThreadTS !== undefined && checkpoint.responseThreadTS !== threadTS)) {
      throw new Error('Log collecting status checkpoint is invalid');
    }
    const key = carrierKey(channel, threadTS);
    if (checkpointByCarrier.has(key)) throw new Error('Duplicate log collecting status checkpoint');
    checkpointByCarrier.set(key, ts);
  }

  const carrierByThread = new Map();
  for (const carrier of carriers) {
    const key = carrierKey(carrier.channel, carrier.threadTS);
    const ts = checkpointByCarrier.get(key);
    if (!ts) throw new Error('Log collecting status checkpoint does not match its carrier');
    if (carrierByThread.has(carrier.threadTS)) throw new Error('Duplicate log collecting status carrier');
    carrierByThread.set(carrier.threadTS, { ...carrier, ts });
  }
  if (checkpointByCarrier.size !== carriers.length) throw new Error('Unexpected log collecting status checkpoint');

  return summarizeByThread(results, expectedRequests).flatMap((summary) => {
    const carrier = carrierByThread.get(summary.target_thread_ts);
    if (!carrier) return [];
    const text = summary.allSucceeded
      ? `Stream log collection completed (${summary.successCount}/${summary.expectedCount}).`
      : `Stream log collection completed with issues (${summary.successCount}/${summary.expectedCount} delivered).`;
    return [{ channel: carrier.channel, ts: carrier.ts, text }];
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildLogStatusUpdates, summarizeByThread };
}

if (typeof $input !== 'undefined') {
  if (!$('Capture Log Collecting Status Checkpoint').isExecuted) return [];
  const carriers = $('Build Log Collecting Status').all().map(({ json }) => json);
  const checkpoints = $('Capture Log Collecting Status Checkpoint').all().map(({ json }) => json);
  const rows = $input.all().map(({ json }) => json);
  const results = rows.filter(({ carrier, checkpoint }) => !carrier && !checkpoint);
  const expectedRequests = $('Build Candidate Log Requests').all().map(({ json }) => json);
  return buildLogStatusUpdates(results, expectedRequests, carriers, checkpoints).map((json) => ({ json }));
}
