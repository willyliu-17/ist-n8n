function requestKey(value) {
  const streamID = String(value?.streamID ?? '').trim();
  const threadTS = String(value?.target_thread_ts ?? '').trim();
  return `${threadTS}:${streamID}`;
}

function countKeys(values) {
  const counts = new Map();
  for (const value of values) {
    const key = requestKey(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function subtractCounts(left, right) {
  const difference = [];
  for (const [key, count] of left) {
    const remaining = count - (right.get(key) || 0);
    for (let index = 0; index < remaining; index += 1) difference.push(key);
  }
  return difference;
}

function summarizeQueryLogResults(results, expectedRequests) {
  if (!Array.isArray(results) || !Array.isArray(expectedRequests)) {
    throw new Error('Query Logs results and expected requests must be arrays');
  }

  const expectedCounts = countKeys(expectedRequests);
  const resultCounts = countKeys(results);
  const missingKeys = subtractCounts(expectedCounts, resultCounts);
  const unexpectedKeys = subtractCounts(resultCounts, expectedCounts);
  const failures = results
    .filter(({ ok }) => ok !== true)
    .map((result) => ({
      streamID: String(result.streamID || ''),
      target_thread_ts: String(result.target_thread_ts || ''),
      failedNode: String(result.failedNode || 'Query Steam Logs v3').slice(0, 100),
      errorMessage: String(result.errorMessage || 'Query Logs child failed').slice(0, 500),
    }));
  const successCount = results.filter(({ ok }) => ok === true).length;
  const allSucceeded = failures.length === 0 && missingKeys.length === 0 && unexpectedKeys.length === 0;
  const issueKeys = [
    ...failures.map(({ target_thread_ts, streamID }) => `${target_thread_ts}:${streamID}`),
    ...missingKeys.map((key) => `missing:${key}`),
    ...unexpectedKeys.map((key) => `unexpected:${key}`),
  ];
  const displayedKeys = issueKeys.slice(0, 10);
  const omittedCount = issueKeys.length - displayedKeys.length;
  const errorMessage = allSucceeded
    ? ''
    : [
      `Query Logs delivery failed: ${failures.length} child error(s), ${missingKeys.length} missing result(s), ${unexpectedKeys.length} unexpected result(s).`,
      displayedKeys.length ? `Affected requests: ${displayedKeys.join(', ')}${omittedCount > 0 ? `, and ${omittedCount} more` : ''}.` : '',
    ].filter(Boolean).join(' ').slice(0, 1500);

  return {
    expectedCount: expectedRequests.length,
    resultCount: results.length,
    successCount,
    failureCount: failures.length,
    missingKeys,
    unexpectedKeys,
    failures,
    allSucceeded,
    errorMessage,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { summarizeQueryLogResults };
}

if (typeof $input !== 'undefined') {
  const results = $input.all().map(({ json }) => json);
  const expectedRequests = $('Build Candidate Log Requests').all().map(({ json }) => json);
  return [{ json: summarizeQueryLogResults(results, expectedRequests) }];
}
