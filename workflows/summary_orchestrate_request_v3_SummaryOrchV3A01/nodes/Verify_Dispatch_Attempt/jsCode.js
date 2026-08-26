function verifyDispatchAttempt(rows, attemptKey) {
  const canonicals = rows.filter((row) => row.attemptKey === attemptKey && row.reconciliationStatus === 'canonical');
  if (canonicals.length !== 1 || canonicals[0].canonicalRowID !== String(canonicals[0].id) || canonicals[0].status !== 'queued') {
    throw new Error('Dispatch requires exactly one canonical queued attempt');
  }
  return { attemptKey };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { verifyDispatchAttempt };

if (typeof $input !== 'undefined') {
  const attemptKey = $('Dispatch Verification Loop').first().json.attemptKey;
  const rows = $input.all().map(({ json }) => json).filter((row) => row.id);
  return [{ json: verifyDispatchAttempt(rows, attemptKey) }];
}
