const items = $input.all().map(({ json }) => json);
const plans = items.filter((item) => item?.kind === 'plan' || item?.kind === 'failure_plan' || item?.kind === 'carrier');
const plan = plans[0];
const rows = items.filter((item) => item?.id);
if (!plan || !plan.input || rows.length === 0) throw new Error('verifier requires direct plan and full reread');
for (const expected of plans) {
  const target = rows.find((item) => item.id === expected.row?.id || item.id === expected.id);
  if (!target) throw new Error('verifier did not reread target row');
  for (const [key, value] of Object.entries(expected.values || {})) if (target[key] !== value) throw new Error(`verifier mismatch: ${key}`);
}
if (plan.action === 'freeze' || plan.kind === 'failure_plan' || plan.nextStage === 'complete') {
  const terminal = rows.find((item) => item.id === plan.row?.id);
  return [{ json: terminal }];
}
const row = plan.action === 'reconcile'
  ? rows.find((item) => item.id === plan.winnerId)
  : rows.find((item) => item.id === plan.row?.id || item.id === plan.id);
if (!row) throw new Error('verifier did not resolve canonical row');
return [{ json: { kind: 'carrier', input: plan.input, requestKey: plan.input.requestKey, row, ownerConditions: plan.ownerConditions, nextStage: plan.nextStage } }];
