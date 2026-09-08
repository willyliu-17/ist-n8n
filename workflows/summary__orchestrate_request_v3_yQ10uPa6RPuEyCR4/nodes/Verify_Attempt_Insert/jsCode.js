function verifyRequestInsert(rows, normalized) {
  if (!rows.length) throw new Error('Request insert was zero-CAS or not readable');
  const immutable = [
    'requestKey', 'requestType', 'orderedStreamsJson', 'existingDialoguesJson',
    'expectedLogicalJobKeysJson', 'channel', 'threadTS',
  ];
  if (!rows.some((row) => immutable.every((field) => row[field] === normalized[field]))) {
    throw new Error('Inserted request payload is not readable exactly');
  }
  return rows;
}

function verifyAttemptInsert(rows, expected) {
  if (!rows.length) throw new Error('Attempt insert was zero-CAS or not readable');
  if (!rows.some((row) => row.attemptKey === expected.attemptKey
    && row.logicalJobKey === expected.logicalJobKey && row.requestKey === expected.requestKey)) {
    throw new Error('Inserted attempt payload is not readable exactly');
  }
  return rows;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { verifyAttemptInsert, verifyRequestInsert };

if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json }) => json).filter((row) => row.id);
  const verified = rows[0]?.attemptKey
    ? verifyAttemptInsert(rows, $('Attempt Loop').first().json)
    : verifyRequestInsert(rows, $('Normalize Request').first().json);
  return verified.map((json) => ({ json }));
}
