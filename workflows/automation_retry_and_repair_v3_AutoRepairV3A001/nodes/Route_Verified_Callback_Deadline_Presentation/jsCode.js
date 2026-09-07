const items = $input.all().map(({ json }) => json).filter((item) => item && Object.keys(item).length);
const carriers = items.filter((item) => item.plan);
const rows = items.filter((item) => !item.plan);
if (!carriers.length || carriers.length > 50) throw new Error('Callback deadline requires 1 to 50 plans');
const plans = new Map();
const desiredFields = ['status', 'errorCode', 'nextRetryAtIso', 'updatedAtIso'];
for (const { plan, attemptKey } of carriers) {
  const { filters, desired } = plan;
  if (typeof attemptKey !== 'string' || !attemptKey || plans.has(attemptKey)
    || filters?.attemptKey !== attemptKey || !Number.isSafeInteger(filters.id) || filters.id <= 0
    || filters.status !== 'waiting_callback' || filters.reconciliationStatus !== 'canonical'
    || filters.canonicalRowID !== String(filters.id) || !filters.callbackDeadlineAtIso
    || !desired || Object.keys(desired).length !== desiredFields.length
    || desiredFields.some((field) => typeof desired[field] !== 'string')
    || !['retry_pending', 'timed_out'].includes(desired.status)
    || desired.errorCode !== 'callback_deadline_exceeded'
    || (desired.status === 'timed_out' ? desired.nextRetryAtIso !== '' : !desired.nextRetryAtIso)) {
    throw new Error('Callback deadline plan is invalid or duplicated');
  }
  plans.set(attemptKey, plan);
}
const byKey = new Map();
const ids = new Set();
for (const row of rows) {
  if (!plans.has(row.attemptKey) || !Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id)
    || !['canonical', 'duplicate', 'pending'].includes(row.reconciliationStatus)) {
    throw new Error('Callback deadline readback is invalid, unplanned or duplicated');
  }
  ids.add(row.id);
  const group = byKey.get(row.attemptKey) || [];
  group.push(row);
  byKey.set(row.attemptKey, group);
}
const notifications = [];
for (const [attemptKey, plan] of plans) {
  const group = byKey.get(attemptKey) || [];
  const canonical = group.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonical.length !== 1) throw new Error('Callback deadline requires one canonical per planned attempt');
  const row = canonical[0];
  if (row.id !== plan.filters.id || row.canonicalRowID !== String(row.id)
    || row.callbackDeadlineAtIso !== plan.filters.callbackDeadlineAtIso
    || desiredFields.some((field) => row[field] !== plan.desired[field])
    || group.some((item) => item.reconciliationStatus === 'duplicate' && item.canonicalRowID !== String(row.id))
    || group.some((item) => item.reconciliationStatus === 'pending' && item.canonicalRowID !== '')) {
    throw new Error('Callback deadline patch was not persisted exactly');
  }
  if (row.status === 'timed_out') notifications.push({ json: { attemptKey } });
}
return notifications;
