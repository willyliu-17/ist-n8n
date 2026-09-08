function verifyRetryDeadlineExhausted(rows, plan) {
  const canonical = rows.filter((row) => row?.reconciliationStatus === 'canonical');
  if (canonical.length !== 1) throw new Error('Retry deadline transition requires exactly one canonical row');
  const row = canonical[0];
  if (!plan?.filters || row.id !== plan.filters.id || row.attemptKey !== plan.filters.attemptKey
    || row.status !== 'timed_out' || row.errorCode !== 'stt_retry_deadline_exceeded'
    || row.nextRetryAtIso !== '' || row.retryLeaseOwner !== '' || row.retryLeaseUntilIso !== ''
    || row.canonicalRowID !== String(row.id) || row.presentationStatus !== 'pending') {
    throw new Error('Retry deadline transition verification failed');
  }
  return { repairClass: 'retry_materialization', candidateKey: row.attemptKey, attemptKey: row.attemptKey, result: 'repaired', terminalStatus: row.status };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { verifyRetryDeadlineExhausted };
if (typeof $input !== 'undefined') return [{ json: verifyRetryDeadlineExhausted(
  $input.all().map(({ json }) => json), $('Retry Deadline Is Exhausted').first().json,
) }];
