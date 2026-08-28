function validIso(value, name) {
  if (typeof value !== 'string' || value === '') throw new Error(`invalid ${name}`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) throw new Error(`invalid ${name}`);
  return millis;
}
function planClaim(request, now, owner) {
  if (!request || typeof request.requestKey !== 'string' || request.requestKey === '' || request.reconciliationStatus !== 'canonical' || request.canonicalRowID !== String(request.id)) throw new Error('claim requires canonical self-linked request');
  const nowMillis = validIso(now, 'current time');
  if (!nonemptyOwner(owner)) throw new Error('claim owner required');
  if (!['ready', 'summary_retry_pending', 'summary_dispatching'].includes(request.status)) return { action: 'noop', status: request.status };
  const leaseUntilIso = new Date(nowMillis + 24 * 60 * 60 * 1000).toISOString();
  const base = { id: request.id, requestKey: request.requestKey, expectedStatus: request.status, expectedReconciliationStatus: 'canonical', expectedCanonicalRowID: String(request.id), expectedLeaseOwner: request.leaseOwner || '', expectedLeaseUntilIso: request.leaseUntilIso || '', owner, leaseUntilIso };
  if (request.status === 'ready') {
    if (request.leaseOwner !== '' || request.leaseUntilIso !== '') return { action: 'noop', status: request.status };
    return { ...base, action: 'initial' };
  }
  if (request.status === 'summary_retry_pending') {
    const due = validIso(request.nextRetryAtIso, 'next retry');
    if (due > nowMillis) return { action: 'noop', status: request.status };
    const hasOwner = nonemptyOwner(request.leaseOwner);
    const hasExpiry = typeof request.leaseUntilIso === 'string' && request.leaseUntilIso !== '';
    if (hasOwner !== hasExpiry) throw new Error('retry claim lease pair is malformed');
    if (hasExpiry && validIso(request.leaseUntilIso, 'lease expiry') > nowMillis) return { action: 'noop', status: request.status };
    return { ...base, action: 'retry_due', expectedNextRetryAtIso: request.nextRetryAtIso };
  }
  if (!nonemptyOwner(request.leaseOwner)) throw new Error('expired claim requires lease owner');
  if (validIso(request.leaseUntilIso, 'lease expiry') > nowMillis) return { action: 'noop', status: request.status };
  return { ...base, action: 'expired' };
}
function nonemptyOwner(value) { return typeof value === 'string' && value !== ''; }
if (typeof module !== 'undefined' && module.exports) module.exports = { planClaim, validIso };
if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json: row }) => row).filter((row) => row.id);
  const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonical.length !== 1) throw new Error('claim requires exactly one canonical request');
  return [{ json: planClaim(canonical[0], new Date().toISOString(), $execution.id) }];
}
