function coverageSnapshot(aggregate) {
  if (!['complete', 'partial'].includes(aggregate.coverageStatus) || !Array.isArray(aggregate.availableRoles) || !Array.isArray(aggregate.missingRoles) || !Array.isArray(aggregate.failedLogicalJobKeys)) throw new Error('invalid coverage aggregate');
  return { coverageStatus: aggregate.coverageStatus, availableRolesJson: JSON.stringify(aggregate.availableRoles), missingRolesJson: JSON.stringify(aggregate.missingRoles), failedLogicalJobKeysJson: JSON.stringify(aggregate.failedLogicalJobKeys) };
}
function planCoverageWrite(request, aggregate) {
  if (!request?.id || !request.requestKey) throw new Error('coverage requires request');
  if (aggregate.action === 'pending') return { action: 'noop', reason: 'nonterminal' };
  if (aggregate.action === 'all_failed') return planAllFailedWrite(request);
  const snapshot = coverageSnapshot(aggregate);
  if (request.status === 'waiting_stt') return { action: 'write_ready', id: request.id, requestKey: request.requestKey, expected: { status: 'waiting_stt', reconciliationStatus: 'canonical', canonicalRowID: request.id, coverageStatus: request.coverageStatus, availableRolesJson: request.availableRolesJson, missingRolesJson: request.missingRolesJson, failedLogicalJobKeysJson: request.failedLogicalJobKeysJson }, desired: { status: 'ready', ...snapshot, leaseOwner: '', leaseUntilIso: '' } };
  if (request.status === 'ready') {
    for (const [field, value] of Object.entries(snapshot)) if (request[field] !== value) throw new Error(`ready coverage replay mismatch: ${field}`);
    return { action: 'replay', id: request.id, requestKey: request.requestKey, expected: { status: 'ready', ...snapshot } };
  }
  return { action: 'noop', reason: 'status_not_coverage_writable', status: request.status };
}
function planAllFailedWrite(request) {
  if (!request?.id || request.reconciliationStatus !== 'canonical' || request.canonicalRowID !== request.id) throw new Error('all-failed requires canonical request');
  const desired = { status: 'failed', errorCode: 'SUMMARY_ALL_STT_LOGICAL_JOBS_FAILED', leaseOwner: '', leaseUntilIso: '' };
  if (request.status === 'failed') {
    if (request.errorCode === desired.errorCode && request.leaseOwner === '' && request.leaseUntilIso === '') return { action: 'noop', reason: 'all_failed_persisted', id: request.id, requestKey: request.requestKey };
    throw new Error('failed request has incompatible all-failed state');
  }
  if (!['waiting_stt', 'ready'].includes(request.status)) throw new Error('all-failed requires waiting or ready canonical request');
  return { action: 'all_failed', id: request.id, requestKey: request.requestKey, expected: { status: request.status, reconciliationStatus: 'canonical', canonicalRowID: request.id, leaseOwner: request.leaseOwner || '', leaseUntilIso: request.leaseUntilIso || '' }, desired };
}
function verifyCoverageWrite(rows, plan) {
  const canonical = rows.filter((row) => row?.requestKey === plan.requestKey && row.reconciliationStatus === 'canonical' && row.canonicalRowID === row.id);
  if (canonical.length !== 1 || canonical[0].id !== plan.id) throw new Error('coverage write requires exactly one canonical');
  const row = canonical[0]; const expected = ['write_ready', 'all_failed'].includes(plan.action) ? plan.desired : plan.expected;
  for (const [key, value] of Object.entries(expected)) if (row[key] !== value) throw new Error(`coverage write mismatch: ${key}`);
  return row;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { coverageSnapshot, planAllFailedWrite, planCoverageWrite, verifyCoverageWrite };
if (typeof $input !== 'undefined') {
  const aggregate = $input.first().json;
  return [{ json: planCoverageWrite(aggregate, aggregate) }];
}
