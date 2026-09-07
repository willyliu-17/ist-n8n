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

function buildLogStatusUpdates(results, expectedRequests, carriers, responses) {
  const responseByCarrier = new Map();
  for (const response of responses) {
    const channel = response?.channel;
    const threadTS = response?.message?.thread_ts;
    const ts = response?.message_timestamp;
    if (response?.ok !== true || typeof channel !== 'string' || typeof threadTS !== 'string'
      || typeof ts !== 'string' || !SLACK_TIMESTAMP_PATTERN.test(ts)) {
      throw new Error('Log collecting status response is invalid');
    }
    const key = carrierKey(channel, threadTS);
    if (responseByCarrier.has(key)) throw new Error('Duplicate log collecting status response');
    responseByCarrier.set(key, ts);
  }

  const carrierByThread = new Map();
  for (const carrier of carriers) {
    const key = carrierKey(carrier.channel, carrier.threadTS);
    const ts = responseByCarrier.get(key);
    if (!ts) throw new Error('Log collecting status response does not match its carrier');
    if (carrierByThread.has(carrier.threadTS)) throw new Error('Duplicate log collecting status carrier');
    carrierByThread.set(carrier.threadTS, { ...carrier, ts });
  }
  if (responseByCarrier.size !== carriers.length) throw new Error('Unexpected log collecting status response');

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
  if (!$('Send Log Collecting Status').isExecuted) return [];
  const carriers = $('Build Log Collecting Status').all().map(({ json }) => json);
  const responses = $('Send Log Collecting Status').all().map(({ json }) => json);
  const rows = $input.all().map(({ json }) => json);
  const results = rows.filter(({ message_timestamp }) => message_timestamp === undefined);
  const expectedRequests = $('Build Candidate Log Requests').all().map(({ json }) => json);
  return buildLogStatusUpdates(results, expectedRequests, carriers, responses).map((json) => ({ json }));
}
