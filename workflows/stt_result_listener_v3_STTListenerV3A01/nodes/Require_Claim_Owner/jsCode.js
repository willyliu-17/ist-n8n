const rows = $input.all().map((item) => item.json).filter((row) => row && Object.keys(row).length);
const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical');
if (canonical.length !== 1 || canonical[0].canonicalRowID !== canonical[0].id) throw new Error('Expected exactly one claimed canonical');
const row = canonical[0];
const eligible = $('Require Eligible Canonical').first().json;
if (row.id !== eligible.id || row.attemptKey !== eligible.attemptKey || row.status !== 'completed' || row.presentationStatus !== 'presenting' || row.presentationLeaseOwner !== $execution.id || row.presentationAttempt !== eligible.nextPresentationAttempt) throw new Error('Presentation claim was not confirmed');
const expiry = Date.parse(row.presentationLeaseUntilIso);
if (!Number.isFinite(expiry) || expiry <= Date.now() || new Date(expiry).toISOString() !== row.presentationLeaseUntilIso) throw new Error('Presentation claim lease is invalid');
return [{ json: row }];
