function verifyMutations(rows, mutations) {
  const expected = new Map(mutations.map((mutation) => [mutation.id, mutation]));
  for (const row of rows) {
    const mutation = expected.get(row.id);
    if (!mutation) continue;
    if (row.reconciliationStatus !== mutation.desiredReconciliationStatus
      || row.canonicalRowID !== mutation.desiredCanonicalRowID
      || (mutation.desiredStatus !== undefined && row.status !== mutation.desiredStatus)) {
      throw new Error('Reconciliation write was not persisted exactly');
    }
    expected.delete(row.id);
  }
  if (expected.size) throw new Error('Reconciliation write was partial or zero-CAS');
  return rows;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { verifyMutations };

if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json }) => json).filter((row) => row.id);
  const mutations = rows[0]?.attemptKey
    ? $('Attempt Reconciliation Needed').all().map(({ json }) => json)
    : $('Request Reconciliation Needed').all().map(({ json }) => json);
  return verifyMutations(rows, mutations).map((json) => ({ json }));
}
