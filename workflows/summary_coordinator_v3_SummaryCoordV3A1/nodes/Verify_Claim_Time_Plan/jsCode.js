function splitPlanAndRows(items, phase) {
  const plans = items.filter((item) => item.__planCarrier === true).map((item) => ({ ...item }));
  const rows = items.filter((item) => item.__planCarrier !== true && item.id);
  if (!plans.length || !rows.length) throw new Error('missing plan carrier or reread rows');
  if (plans.some((plan) => plan.__planPhase !== phase || plan.__planAction !== plan.action)) throw new Error('mixed phase plan carrier');
  const ids = new Set();
  for (const plan of plans) {
    if (!plan.id || ids.has(plan.id)) throw new Error('duplicate plan carrier');
    ids.add(plan.id);
    delete plan.__planCarrier;
    delete plan.__planPhase;
    delete plan.__planAction;
  }
  return { plans, rows };
}
function verifyPlan(rows, mutations, action, requestKey) {
  const expected = new Map(mutations.map((mutation) => [mutation.id, mutation]));
  for (const row of rows) {
    const mutation = expected.get(row.id);
    if (!mutation) continue;
    if (action === 'manual_review') {
      if (row.status !== 'manual_review' || row.reconciliationStatus !== 'canonical' || row.canonicalRowID !== row.id || row.manualReviewReason !== 'multiple_canonical_checkpoint_conflict') throw new Error('request conflict freeze mismatch');
    } else if (row.reconciliationStatus !== mutation.desiredReconciliationStatus || row.canonicalRowID !== mutation.desiredCanonicalRowID) throw new Error('request reconciliation write mismatch');
    expected.delete(row.id);
  }
  if (expected.size) throw new Error('request write was partial or zero-CAS');
  const canonical = rows.filter((row) => row.id && row.requestKey === requestKey && row.reconciliationStatus === 'canonical' && row.canonicalRowID === row.id);
  if (action !== 'manual_review' && canonical.length !== 1) throw new Error('request reread does not contain exactly one canonical');
  return action === 'manual_review' ? null : canonical[0] || null;
}
function verifyCarrierInput(items, phase) {
  const { plans: mutations, rows } = splitPlanAndRows(items, phase);
  const result = verifyPlan(rows, mutations, mutations[0]?.action, mutations[0]?.requestKey);
  return result ? [result] : [];
}
if (typeof module !== 'undefined' && module.exports) module.exports = { splitPlanAndRows, verifyPlan, verifyCarrierInput };
if (typeof $input !== 'undefined') {
  return verifyCarrierInput($input.all().map(({ json }) => ({ ...json })), 'claim-time').map((json) => ({ json }));
}
