const ATTEMPT_CHECKPOINTS = ['submittedAtIso', 'callbackDeadlineAtIso', 'consumedAtIso', 'dialogue', 'transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso'];
const SUMMARY_CHECKPOINTS = ['inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS'];
const statuses = new Set(['pending', 'canonical', 'duplicate']);
const present = (value) => value !== undefined && value !== null && value !== '';
const compare = (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function planCanonicalReconciliation(rawRows, rawSummaries = []) {
  const rows = rawRows.filter((row) => row && Object.keys(row).length);
  const summaries = rawSummaries.filter((row) => row && Object.keys(row).length);
  if (!rows.length) throw new Error('Attempt row not found');
  const { attemptKey, requestKey } = rows[0];
  if (typeof attemptKey !== 'string' || !attemptKey || typeof requestKey !== 'string' || !requestKey) throw new Error('Invalid attempt identity');
  for (const row of rows) {
    if (!row.id || !row.createdAt || !row.updatedAt || row.attemptKey !== attemptKey || row.requestKey !== requestKey) throw new Error('Invalid same-attempt rows');
    if (typeof row.status !== 'string' || !row.status.trim() || row.status !== row.status.trim()) throw new Error('Invalid attempt status');
    if (!statuses.has(row.reconciliationStatus)) throw new Error('Invalid reconciliation status');
    if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== row.id) throw new Error('Invalid canonical linkage');
    if (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') throw new Error('Invalid pending linkage');
    if (row.reconciliationStatus === 'duplicate' && !row.canonicalRowID) throw new Error('Invalid duplicate linkage');
  }
  if (summaries.some((row) => row.requestKey !== requestKey)) throw new Error('Summary requestKey mismatch');
  const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical');
  const mutation = (row, winner, desired) => ({
    id: row.id, attemptKey, expectedStatus: row.status,
    expectedReconciliationStatus: row.reconciliationStatus,
    expectedCanonicalRowID: row.canonicalRowID || '',
    desiredReconciliationStatus: desired, desiredCanonicalRowID: winner,
  });
  if (canonical.length > 1) {
    const checkpoint = rows.some((row) => ATTEMPT_CHECKPOINTS.some((field) => present(row[field])))
      || summaries.some((row) => SUMMARY_CHECKPOINTS.some((field) => present(row[field])));
    if (checkpoint) return { action: 'manual_review', mutations: canonical.map((row) => mutation(row, row.id, 'canonical')) };
    const [winner, ...losers] = [...canonical].sort(compare);
    return { action: 'reconcile', mutations: losers.map((row) => mutation(row, winner.id, 'duplicate')) };
  }
  if (canonical.length === 1) {
    const winner = canonical[0];
    const mutations = rows.filter((row) => row.id !== winner.id)
      .filter((row) => row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== winner.id)
      .map((row) => mutation(row, winner.id, 'duplicate'));
    return mutations.length ? { action: 'reconcile', mutations } : { action: 'ready', canonical: winner, mutations: [] };
  }
  const [winner] = [...rows].sort(compare);
  return { action: 'reconcile', mutations: rows.map((row) => mutation(row, winner.id, row.id === winner.id ? 'canonical' : 'duplicate')) };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { planCanonicalReconciliation };

if (typeof $input !== 'undefined') {
  const source = $('Re-read After Reconciliation').isExecuted ? $('Re-read After Reconciliation').all() : $('Read All Attempt Rows').all();
  const plan = planCanonicalReconciliation(source.map((item) => item.json), $input.all().map((item) => item.json));
  if (plan.action === 'ready') return [{ json: { ...plan.canonical, reconciliationAction: 'ready' } }];
  return plan.mutations.map((mutation) => ({ json: { ...mutation, reconciliationAction: plan.action } }));
}
