const imported = typeof require === 'function' ? require('../Aggregate_Logical_Jobs/jsCode') : {};
const { planRequestReconciliation } = imported;
function planClaimReconciliation(rows, requestKey) { return planRequestReconciliation(rows, requestKey); }
if (typeof module !== 'undefined' && module.exports) module.exports = { planClaimReconciliation };
if (typeof $input !== 'undefined') {
  const plan = planClaimReconciliation($input.all().map(({ json }) => json).filter((row) => row.id), $('Start').first().json.requestKey);
  if (plan.action === 'ready') return [{ json: { ...plan.canonical, action: 'ready' } }];
  return plan.mutations.map((mutation) => ({ json: { ...mutation, action: plan.action } }));
}
