function verifyOrphans(rows, mutations) {
  const action = mutations[0]?.orphanAction || mutations[0]?.action;
  const expected = new Map(mutations.map((mutation) => [mutation.id, mutation]));
  if (action === 'delete') {
    if (rows.some((row) => expected.has(row.id))) throw new Error('Planned orphan row still exists after delete');
    return [{ json: { orphanAction: 'replan' } }];
  }
  for (const row of rows) {
    const mutation = expected.get(row.id);
    if (!mutation) continue;
    if (row.status !== mutation.desiredStatus || row.reconciliationStatus !== mutation.desiredReconciliationStatus
      || row.canonicalRowID !== mutation.desiredCanonicalRowID) throw new Error('Orphan reconciliation write was not persisted exactly');
    expected.delete(row.id);
  }
  if (expected.size) throw new Error('Orphan reconciliation write was partial or zero-CAS');
  return action === 'manual_review' ? [] : [{ json: { orphanAction: 'replan' } }];
}

if (typeof module !== 'undefined' && module.exports) module.exports = { verifyOrphans };

if (typeof $input !== 'undefined') {
  return verifyOrphans(
    $input.all().map(({ json }) => json).filter((row) => row.id),
    $('Orphan Mutation Plan').all().map(({ json }) => json),
  );
}
