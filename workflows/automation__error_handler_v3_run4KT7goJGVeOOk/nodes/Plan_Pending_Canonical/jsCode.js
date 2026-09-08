const rows = $input.all().map(({ json }) => json).filter((row) => row && Number.isInteger(row.id) && row.id > 0);
if (!rows.length) throw new Error('pending error insert was not found');
const compare = (left, right) => left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id - right.id;
const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical');
const winner = canonical.length === 1 ? canonical[0] : [...(canonical.length ? canonical : rows)].sort(compare)[0];
return rows.map((row) => ({ json: { id: row.id, errorKey: row.errorKey, expectedReconciliationStatus: row.reconciliationStatus, expectedCanonicalRowID: row.canonicalRowID || '', desiredReconciliationStatus: row.id === winner.id ? 'canonical' : 'duplicate', desiredCanonicalRowID: String(row.id === winner.id ? row.id : winner.id) } }));