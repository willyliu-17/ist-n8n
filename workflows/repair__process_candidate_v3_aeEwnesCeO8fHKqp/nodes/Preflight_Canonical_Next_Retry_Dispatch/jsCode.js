const rows = $input.all().map(({ json }) => json).filter((row) => row && Number.isInteger(row.id) && row.id > 0);
if (rows.length === 0) throw new Error('Retry dispatch preflight rows not found');
const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
if (canonicals.length !== 1) throw new Error('Retry dispatch preflight requires exactly one canonical');
const canonical = canonicals[0];
if (canonical.status !== 'queued' || canonical.dispatchLeaseOwner !== '' || canonical.dispatchLeaseUntilIso !== '') throw new Error('Retry dispatch preflight failed');
if (rows.some((row) => row.attemptKey !== canonical.attemptKey || (row.id !== canonical.id && (row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(canonical.id))))) throw new Error('Retry dispatch preflight row set mismatch');
return [{ json: { attemptKey: canonical.attemptKey } }];