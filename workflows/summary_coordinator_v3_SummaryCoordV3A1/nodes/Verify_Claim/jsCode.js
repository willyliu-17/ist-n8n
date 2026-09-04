function validIso(value, name) {
  if (typeof value !== 'string' || value === '') throw new Error(`invalid ${name}`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) throw new Error(`invalid ${name}`);
  return millis;
}
function verifyClaim(rows, requestKey, owner, now, expectedLeaseUntilIso) {
  const canonical = rows.filter((row) => row?.id && row.requestKey === requestKey && row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
  if (canonical.length !== 1) throw new Error('claim reread requires exactly one canonical request');
  const row = canonical[0];
  if (row.status !== 'summary_dispatching' || row.leaseOwner !== owner) throw new Error('claim owner mismatch');
  const expiry = validIso(row.leaseUntilIso, 'lease expiry');
  if (expectedLeaseUntilIso && row.leaseUntilIso !== expectedLeaseUntilIso) throw new Error('claim lease replacement mismatch');
  if (expiry <= validIso(now, 'current time')) throw new Error('claim lease invalid or expired');
  return row;
}
function splitPlanAndRows(items) {
  const plans = items.filter((item) => item.__planCarrier === true).map((item) => ({ ...item }));
  const rows = items.filter((item) => item.__planCarrier !== true && item.id);
  if (plans.length !== 1 || !rows.length) throw new Error('claim requires one plan carrier and reread rows');
  const plan = { ...plans[0] };
  if (plan.__planPhase !== 'claim' || plan.__planAction !== plan.action) throw new Error('mixed phase plan carrier');
  delete plan.__planCarrier;
  delete plan.__planPhase;
  delete plan.__planAction;
  return { plan, rows };
}
function verifyClaimRuntime(items, now = new Date().toISOString()) {
  const { plan, rows } = splitPlanAndRows(items);
  try {
    return [verifyClaim(rows, plan.requestKey, plan.owner, now, plan.leaseUntilIso)];
  } catch (error) {
    // Concurrent callbacks legitimately lose the exact lease compare-and-swap.
    if (error instanceof Error && error.message === 'claim owner mismatch') return [];
    throw error;
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { splitPlanAndRows, verifyClaim, verifyClaimRuntime };
if (typeof $input !== 'undefined') {
  return verifyClaimRuntime($input.all().map(({ json }) => ({ ...json }))).map((json) => ({ json }));
}
