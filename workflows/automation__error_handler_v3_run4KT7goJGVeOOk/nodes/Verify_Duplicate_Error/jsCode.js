const rows = $input.all().map(({ json }) => json).filter((row) => row && Number.isInteger(row.id) && row.id > 0);
const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical');
if (canonical.length !== 1 || canonical[0].canonicalRowID !== String(canonical[0].id) || rows.some((row) => row.reconciliationStatus !== 'canonical' && (row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(canonical[0].id)))) throw new Error('duplicate error verification failed');
return [{ json: { errorKey: canonical[0].errorKey, canonicalRowID: String(canonical[0].id) } }];