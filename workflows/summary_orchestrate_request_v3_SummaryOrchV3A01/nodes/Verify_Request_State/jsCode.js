function verifyTransition(rows, plan, executionID) {
  const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonical.length !== 1) throw new Error('Expected exactly one canonical request after transition');
  const row = canonical[0];
  if (row.id !== plan.id || row.requestKey !== plan.requestKey || row.status !== plan.status
    || row.creationLeaseOwner !== '' || row.creationLeaseUntilIso !== ''
    || row.coverageStatus !== plan.coverageStatus
    || row.availableRolesJson !== plan.availableRolesJson
    || row.missingRolesJson !== plan.missingRolesJson
    || row.failedLogicalJobKeysJson !== plan.failedLogicalJobKeysJson) {
    throw new Error('Request transition was not persisted exactly');
  }
  if (plan.expectedCreationLeaseOwner !== executionID) throw new Error('Transition plan owner mismatch');
  return { ...row, transitionAction: row.status, dispatchAttempts: plan.dispatchAttempts };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { verifyTransition };

if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json }) => json).filter((row) => row.id);
  return [{ json: verifyTransition(rows, $('Verify Coverage').first().json, $execution.id) }];
}
