const SLACK_TS = /^\d{10,}\.\d{6}$/;
const CREATION_STATUS = new Set(['creating']);
const COVERAGE_STATUS = new Set(['waiting_stt', 'ready']);
const ALLOWED_CHANNELS = new Set(['C0A4JJJKJMD', 'C09F0SYG57D']);

function validIso(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function validateRow(row, requestKey) {
  if (!row || !Number.isSafeInteger(row.id) || row.id <= 0) throw new Error('Invalid request system field: id');
  for (const field of ['createdAt', 'updatedAt']) {
    if (!validIso(row[field])) throw new Error(`Invalid request system field: ${field}`);
  }
  for (const field of ['requestKey', 'channel', 'threadTS', 'creationLeaseOwner', 'creationLeaseUntilIso', 'summaryMessageTS', 'inferenceResultJson', 'summaryMarkdown', 'summaryUploadID']) {
    if (typeof row[field] !== 'string') throw new Error(`Invalid request field: ${field}`);
  }
  if (row.requestKey !== requestKey || !ALLOWED_CHANNELS.has(row.channel) || !SLACK_TS.test(row.threadTS)) {
    throw new Error('Initial status routing is invalid');
  }
}

function planInitialSummaryStatus(rows, coveragePlan, executionID, nowIso = new Date().toISOString()) {
  if (!coveragePlan || !COVERAGE_STATUS.has(coveragePlan.status)) throw new Error('Coverage plan has an invalid desired status');
  if (typeof executionID !== 'string' || executionID === '') throw new Error('executionID is required');
  if (!validIso(nowIso)) throw new Error('Invalid current time');
  for (const row of rows) validateRow(row, coveragePlan.requestKey);
  const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicals.length !== 1) throw new Error('Expected exactly one canonical request');
  const row = canonicals[0];
  if (row.canonicalRowID !== String(row.id) || !CREATION_STATUS.has(row.status)
    || row.creationLeaseOwner !== executionID || !validIso(row.creationLeaseUntilIso)
    || Date.parse(row.creationLeaseUntilIso) <= Date.parse(nowIso)) {
    throw new Error('Current execution does not own creation lease');
  }
  if (row.id !== coveragePlan.id || coveragePlan.expectedCreationLeaseOwner !== executionID
    || row.creationLeaseUntilIso !== coveragePlan.creationLeaseUntilIso) {
    throw new Error('Coverage plan creation snapshot mismatch');
  }
  for (const field of ['requestKey', 'channel', 'threadTS']) {
    if (row[field] !== coveragePlan[field]) throw new Error(`Coverage plan immutable mismatch: ${field}`);
  }
  if (row.summaryMessageTS !== '' && !SLACK_TS.test(row.summaryMessageTS)) throw new Error('Persisted summary message timestamp is invalid');
  return {
    ...coveragePlan,
    id: row.id,
    creationLeaseUntilIso: row.creationLeaseUntilIso,
    expectedUpdatedAt: row.updatedAt,
    expectedUpdatedAtIso: row.updatedAtIso,
    expectedCreationLeaseUntilIso: row.creationLeaseUntilIso,
    expectedInferenceResultJson: row.inferenceResultJson,
    expectedSummaryMarkdown: row.summaryMarkdown,
    expectedSummaryUploadID: row.summaryUploadID,
    expectedSummaryMessageTS: row.summaryMessageTS,
    summaryMessageAction: row.summaryMessageTS === '' ? 'post' : 'reuse',
    summaryMessageText: coveragePlan.status === 'waiting_stt'
      ? 'AI summary request started. Waiting for STT results.'
      : 'AI summary queued. Preparing analysis.',
    summaryMessageTS: row.summaryMessageTS,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { planInitialSummaryStatus };

if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json }) => json).filter((row) => row.id);
  return [{ json: planInitialSummaryStatus(rows, $('Verify Coverage').first().json, $execution.id) }];
}
