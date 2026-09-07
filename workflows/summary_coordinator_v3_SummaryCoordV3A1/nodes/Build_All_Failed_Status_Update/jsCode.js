const SLACK_TS = /^\d{10,}\.\d{6}$/;
const ALLOWED_CHANNELS = new Set(['C0A4JJJKJMD', 'C09F0SYG57D']);
const ERROR_CODE = 'SUMMARY_ALL_STT_LOGICAL_JOBS_FAILED';

function buildAllFailedStatusUpdate(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('all-failed status update requires one verified row');
  const row = rows[0];
  if (!row || row.reconciliationStatus !== 'canonical' || row.canonicalRowID !== String(row.id)
    || row.status !== 'failed' || row.errorCode !== ERROR_CODE || row.leaseOwner !== '' || row.leaseUntilIso !== '') {
    return [];
  }
  if (typeof row.requestKey !== 'string' || row.requestKey === '') throw new Error('all-failed status update has invalid request key');
  if (!ALLOWED_CHANNELS.has(row.channel)) throw new Error('all-failed status update has invalid channel');
  if (typeof row.threadTS !== 'string' || !SLACK_TS.test(row.threadTS)) throw new Error('all-failed status update has invalid thread timestamp');
  if (row.summaryMessageTS === '') return [];
  if (typeof row.summaryMessageTS !== 'string' || !SLACK_TS.test(row.summaryMessageTS)) throw new Error('all-failed status update has invalid summary message timestamp');
  return [{
    requestKey: row.requestKey,
    channel: row.channel,
    threadTS: row.threadTS,
    summaryMessageTS: row.summaryMessageTS,
    statusText: 'AI summary request failed. All STT logical jobs failed.',
  }];
}

if (typeof module !== 'undefined' && module.exports) module.exports = { buildAllFailedStatusUpdate };

if (typeof $input !== 'undefined') {
  return buildAllFailedStatusUpdate($input.all().map(({ json }) => ({ ...json }))).map((json) => ({ json }));
}
