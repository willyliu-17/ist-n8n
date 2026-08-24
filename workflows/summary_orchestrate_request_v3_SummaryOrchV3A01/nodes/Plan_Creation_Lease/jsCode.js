if (typeof $input !== 'undefined') {
  const row = $input.first().json;
  const owner = row.creationLeaseOwner || '';
  const until = row.creationLeaseUntilIso || '';
  if (row.status !== 'creating') return [{ json: { ...row, leaseAction: 'accepted' } }];
  if (row.reconciliationStatus !== 'canonical' || row.canonicalRowID !== row.id) throw new Error('Creation lease requires canonical request');
  const expires = until === '' ? Number.NEGATIVE_INFINITY : Date.parse(until);
  if (until !== '' && !Number.isFinite(expires)) throw new Error('Invalid creation lease expiry');
  const now = Date.now();
  let leaseAction = 'claim';
  if (owner === $execution.id && expires > now) leaseAction = 'resume';
  else if (owner !== '' && owner !== $execution.id && expires > now) leaseAction = 'blocked';
  return [{ json: { ...row, leaseAction, expectedCreationLeaseOwner: owner, expectedCreationLeaseUntilIso: until } }];
}
