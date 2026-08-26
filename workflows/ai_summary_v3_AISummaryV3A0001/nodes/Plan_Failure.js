function planFailure(items, now = new Date()) {
  const carrier = items.find((item) => item?.kind === 'failure_carrier');
  if (!carrier || !carrier.failureStage || !carrier.input || !carrier.row) throw new Error('failure plan requires explicit sanitized stage carrier');
  const rows = items.filter((item) => item?.id);
  const canonical = rows.filter((item) => item.reconciliationStatus === 'canonical' && item.canonicalRowID === String(item.id));
  if (canonical.length !== 1) throw new Error('failure canonical gate failed');
  const row = canonical[0];
  if (row.id !== carrier.row.id || row.status !== 'summary_dispatching' || row.leaseOwner !== carrier.row.leaseOwner || row.leaseUntilIso !== carrier.row.leaseUntilIso || Date.parse(row.leaseUntilIso) <= now.getTime()) throw new Error('failure owner gate failed');
  const attempt = Number(row.summaryAttempt || 0) + 1;
  const terminal = attempt >= 3;
  return { kind: 'failure_plan', input: carrier.input, requestKey: carrier.input.requestKey, row, ownerConditions: carrier.ownerConditions, failureStage: carrier.failureStage, values: { summaryAttempt: attempt, status: terminal ? 'failed' : 'summary_retry_pending', nextRetryAtIso: terminal ? '' : new Date(now.getTime() + (attempt === 1 ? 60000 : 300000)).toISOString(), leaseOwner: '', leaseUntilIso: '', errorCode: carrier.errorCode } };
}
if (typeof module !== 'undefined') module.exports = { planFailure };
if (typeof $input !== 'undefined') return [{ json: planFailure($input.all().map(({ json }) => json)) }];
