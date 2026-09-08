const items = $input.all().map(({ json }) => json);
const candidates = new Map();
for (const item of items.filter((row) => row?.kind === 'candidate')) {
  if (!item.attemptKey || candidates.has(item.attemptKey)) throw new Error('Callback deadline candidates must have unique attempt keys');
  candidates.set(item.attemptKey, item);
}
const attempts = items.filter((row) => row?.id && row.attemptKey && row.kind !== 'candidate');
const requests = items.filter((row) => row?.id && !row.attemptKey && row.requestKey && row.kind !== 'candidate');
const taggedAttempts = attempts.map((row) => {
  const candidate = candidates.get(row.attemptKey);
  if (!candidate) throw new Error('Callback deadline reread has no matching candidate');
  return { json: { ...row, nowIso: candidate.nowIso || new Date().toISOString(), repairMode: 'actual:callback_deadline' } };
});
return [...taggedAttempts, ...requests.map((row) => ({ json: { ...row, repairMode: 'actual:callback_deadline' } }))];