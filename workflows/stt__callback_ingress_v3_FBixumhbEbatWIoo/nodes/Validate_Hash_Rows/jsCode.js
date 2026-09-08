const HASH_IDENTITY_FIELDS = Object.freeze([
  'attemptKey',
  'logicalJobKey',
  'requestKey',
  'requestType',
  'role',
  'streamID',
  'mode',
  'channel',
  'threadTS',
  'processingMessageTS',
]);

function systemRowID(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  return typeof value === 'string' && value !== '';
}

function validateHashRows(rows, hash) {
  if (!Array.isArray(rows) || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error('Invalid token hash lookup');
  }
  const meaningfulRows = rows.filter((row) => row && Object.keys(row).length > 0);
  if (meaningfulRows.length === 0) return { found: false };

  const expectedIdentity = meaningfulRows[0];
  for (const row of meaningfulRows) {
    if (
      !systemRowID(row.id) ||
      row.callbackTokenHash !== hash ||
      HASH_IDENTITY_FIELDS.some((field) => (
        typeof row[field] !== 'string' || row[field] === '' ||
        row[field] !== expectedIdentity[field]
      ))
    ) {
      throw new Error('Invalid token hash lookup');
    }
  }
  return { found: true, attemptKey: expectedIdentity.attemptKey };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateHashRows };
}

if (typeof $input !== 'undefined') {
  const result = validateHashRows(
    $input.all().map(({ json }) => json),
    $('Hash Callback Token').first().json.callbackTokenHash,
  );
  return [{ json: result }];
}
