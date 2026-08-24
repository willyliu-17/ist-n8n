function canonical(rows, requestKey) {
  const result = rows.filter((row) => row.id && row.requestKey === requestKey && row.reconciliationStatus === 'canonical' && row.canonicalRowID === row.id);
  if (result.length !== 1) throw new Error('request reread does not contain exactly one canonical');
  return result[0];
}
function verifyRequestWrite(rows, plan) {
  const row = canonical(rows, plan.requestKey);
  for (const [field, value] of Object.entries(plan.expected || {})) if (row[field] !== value) throw new Error(`request write mismatch: ${field}`);
  return row;
}
function splitPlanAndRows(items) {
  const plans = items.filter((item) => item.__planCarrier === true).map((item) => ({ ...item }));
  const rows = items.filter((item) => item.__planCarrier !== true && item.id);
  if (plans.length !== 1 || !rows.length) throw new Error('coverage requires one plan carrier and reread rows');
  const plan = { ...plans[0] };
  if (plan.__planPhase !== 'coverage' || plan.__planAction !== plan.action) throw new Error('mixed phase plan carrier');
  delete plan.__planCarrier;
  delete plan.__planPhase;
  delete plan.__planAction;
  return { plan, rows };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { canonical, splitPlanAndRows, verifyRequestWrite };

if (typeof $input !== 'undefined') {
  const { plan: coverage, rows } = splitPlanAndRows($input.all().map(({ json }) => ({ ...json })));
  return [{ json: verifyRequestWrite(rows, { requestKey: coverage.requestKey, expected: ['write_ready', 'all_failed'].includes(coverage.action) ? coverage.desired : coverage.expected }) }];
}
