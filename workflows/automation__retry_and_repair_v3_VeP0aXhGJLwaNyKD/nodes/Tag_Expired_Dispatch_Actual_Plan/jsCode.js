const items = $input.all().map(({ json }) => json);
const candidates = new Map();
for (const item of items.filter((row) => row?.kind === 'candidate')) {
  if (!item.attemptKey || candidates.has(item.attemptKey)) throw new Error('Expired dispatch candidates must have unique attempt keys');
  candidates.set(item.attemptKey, item);
}
const rawRows = items.filter((row) => row?.id && row.kind !== 'candidate');
return rawRows.map((row) => {
  const candidate = candidates.get(row.attemptKey);
  if (!candidate) throw new Error('Expired dispatch reread has no matching candidate');
  return { json: { ...row, nowIso: candidate.nowIso || new Date().toISOString(), repairMode: 'actual:expired_dispatch' } };
});