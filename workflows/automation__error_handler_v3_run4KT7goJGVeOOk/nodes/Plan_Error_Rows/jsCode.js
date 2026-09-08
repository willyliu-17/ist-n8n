const items = $input.all().map(({ json }) => json).filter(Boolean);
const candidates = items.filter((row) => row && !Number.isInteger(row.id) && row.errorKey);
if (!candidates.length) throw new Error('missing error candidate');
const candidate = candidates[0];
const immutable = ['errorKey', 'component', 'requestKey', 'logicalJobKey', 'attemptKey', 'executionID', 'workflowName', 'nodeName', 'errorCode', 'messageMasked', 'retryable'];
if (candidates.some((row) => immutable.some((key) => String(row[key] ?? '') !== String(candidate[key] ?? '')))) throw new Error('multiple inconsistent error candidates');
const rows = items.filter((row) => row && Number.isInteger(row.id) && row.id > 0);
const compare = (left, right) => left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id - right.id;
for (const row of rows) {
  if (!row.createdAt || !['pending', 'canonical', 'duplicate'].includes(row.reconciliationStatus)) throw new Error('invalid error reconciliation system fields');
  if (typeof row.canonicalRowID !== 'string' || (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== String(row.id)) || (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') || (row.reconciliationStatus === 'duplicate' && row.canonicalRowID === '')) throw new Error('invalid error reconciliation linkage');
  if (immutable.some((key) => String(row[key] ?? '') !== String(candidate[key] ?? ''))) throw new Error('immutable masked error payload drift');
}
if (!rows.length) return [{ json: { ...candidate, action: 'insert_pending' } }];
const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical');
const winner = canonicals.length === 1 ? canonicals[0] : [...(canonicals.length ? canonicals : rows)].sort(compare)[0];
const mutations = rows.filter((row) => row.id === winner.id ? row.reconciliationStatus !== 'canonical' || row.canonicalRowID !== String(row.id) : row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(winner.id)).map((row) => ({ ...candidate, action: 'reconcile', id: row.id, expectedReconciliationStatus: row.reconciliationStatus, expectedCanonicalRowID: row.canonicalRowID || '', desiredReconciliationStatus: row.id === winner.id ? 'canonical' : 'duplicate', desiredCanonicalRowID: String(row.id === winner.id ? row.id : winner.id), canonicalRowID: String(winner.id) }));
return mutations.length ? mutations.map((json) => ({ json })) : [{ json: { ...candidate, action: 'insert_duplicate', canonicalRowID: String(winner.id) } }];