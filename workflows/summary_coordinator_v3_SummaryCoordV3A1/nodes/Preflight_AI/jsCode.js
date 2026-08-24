const imported = typeof require === 'function' ? require('../Aggregate_Logical_Jobs/jsCode') : {};
const { aggregateLogicalJobs, planRequestReconciliation, strictIso } = imported;

function preflightAI(requestRows, attemptRows, requestKey, owner, nowIso) {
  const reconciliation = planRequestReconciliation(requestRows, requestKey);
  if (reconciliation.action !== 'ready') return { action: reconciliation.action, mutations: reconciliation.mutations };
  const request = reconciliation.canonical;
  if (request.status !== 'summary_dispatching' || request.leaseOwner !== owner || !request.leaseUntilIso || strictIso(request.leaseUntilIso, 'lease expiry') <= strictIso(nowIso, 'current time')) throw new Error('pre-AI owner gate failed');
  const aggregate = aggregateLogicalJobs(request, attemptRows);
  if (!['complete', 'partial'].includes(aggregate.coverageStatus)) throw new Error('pre-AI coverage is not usable');
  const expected = {
    coverageStatus: aggregate.coverageStatus,
    availableRolesJson: JSON.stringify(aggregate.availableRoles),
    missingRolesJson: JSON.stringify(aggregate.missingRoles),
    failedLogicalJobKeysJson: JSON.stringify(aggregate.failedLogicalJobKeys),
  };
  for (const [field, value] of Object.entries(expected)) if (request[field] !== value) throw new Error(`pre-AI persisted coverage mismatch: ${field}`);
  return { ...request, ...aggregate, action: 'ai' };
}
function runPreflightRuntime(requestRows, attemptRows, requestKey, owner, nowIso) {
  const result = preflightAI(requestRows, attemptRows, requestKey, owner, nowIso);
  if (result.action === 'ready' || result.action === 'reconcile' || result.action === 'manual_review') return result.mutations.map((mutation) => ({ ...mutation, action: result.action }));
  return [result];
}
if (typeof module !== 'undefined' && module.exports) module.exports = { preflightAI, runPreflightRuntime };
if (typeof $input !== 'undefined') {
  const requestRows = $('Re-read Request Before AI').all().map(({ json }) => json).filter((row) => row.id);
  const requestKey = $('Start').first().json.requestKey;
  return runPreflightRuntime(requestRows, $input.all().map(({ json }) => json).filter((row) => row.id), requestKey, $execution.id, new Date().toISOString()).map((json) => ({ json }));
}
