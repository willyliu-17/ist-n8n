function parseIso(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`Invalid ${field}`);
  }
  return timestamp;
}

function requireCanonicalOwner(rows, owner, nowIso) {
  const canonicalRows = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  if (canonicalRows.length !== 1) throw new Error('Expected exactly one canonical attempt');
  const canonical = canonicalRows[0];
  if (canonical.canonicalRowID !== canonical.id) throw new Error('Canonical row does not point to itself');
  if (canonical.status !== 'dispatching') throw new Error('Canonical attempt is not dispatching');
  if (canonical.dispatchLeaseOwner !== owner) throw new Error('Dispatch lease owner mismatch');
  const now = parseIso(nowIso, 'current time');
  const leaseUntil = parseIso(canonical.dispatchLeaseUntilIso, 'dispatch lease');
  if (leaseUntil <= now) throw new Error('Dispatch lease expired');
  return canonical;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { requireCanonicalOwner };
}

if (typeof $input !== 'undefined') {
  return [{
    json: requireCanonicalOwner(
      $input.all().map(({ json }) => json),
      $execution.id,
      new Date().toISOString(),
    ),
  }];
}
