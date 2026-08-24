function verifyOwner(rows, requestKey, executionID, nowIso = new Date().toISOString()) {
  const canonical = rows.filter((row) => row.requestKey === requestKey && row.reconciliationStatus === 'canonical');
  if (canonical.length !== 1) throw new Error('Expected exactly one canonical request');
  const row = canonical[0];
  if (row.canonicalRowID !== row.id || row.status !== 'creating' || row.creationLeaseOwner !== executionID
    || !Number.isFinite(Date.parse(row.creationLeaseUntilIso))
    || Date.parse(row.creationLeaseUntilIso) <= Date.parse(nowIso)) throw new Error('Current execution does not own creation lease');
  return row;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { verifyOwner };

if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json }) => json).filter((row) => row.id);
  return [{ json: verifyOwner(rows, $('Normalize Request').first().json.requestKey, $execution.id) }];
}
