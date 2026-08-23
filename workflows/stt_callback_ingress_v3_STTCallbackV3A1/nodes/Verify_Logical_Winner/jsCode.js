const CALLBACK_IDENTITY_FIELDS = Object.freeze([
  'id',
  'callbackTokenHash',
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
const LOGICAL_PROVENANCE_FIELDS = Object.freeze([
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
const RECONCILIATION_STATUSES = new Set(['pending', 'canonical', 'duplicate']);

function isExactIso(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function compareCompleted(left, right) {
  if (left.consumedAtIso < right.consumedAtIso) return -1;
  if (left.consumedAtIso > right.consumedAtIso) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function validateLogicalRows(rows, expected) {
  if (!Array.isArray(rows) || !expected || typeof expected.logicalJobKey !== 'string' || expected.logicalJobKey === '') {
    throw new Error('Invalid logical job verification input');
  }
  if (LOGICAL_PROVENANCE_FIELDS.some((field) => typeof expected[field] !== 'string' || expected[field] === '')) {
    throw new Error('Invalid immutable logical provenance');
  }
  const meaningfulRows = rows.filter((row) => row && Object.keys(row).length > 0);
  if (meaningfulRows.length === 0) throw new Error('Logical job rows not found');

  const ids = new Set();
  const attempts = new Map();
  for (const row of meaningfulRows) {
    if (
      typeof row.id !== 'string' || row.id === '' || ids.has(row.id) ||
      typeof row.attemptKey !== 'string' || row.attemptKey === '' ||
      !RECONCILIATION_STATUSES.has(row.reconciliationStatus)
    ) {
      throw new Error('Invalid logical job row integrity');
    }
    if (LOGICAL_PROVENANCE_FIELDS.some((field) => row[field] !== expected[field])) {
      throw new Error('Immutable logical provenance mismatch');
    }
    ids.add(row.id);
    if (!attempts.has(row.attemptKey)) attempts.set(row.attemptKey, []);
    attempts.get(row.attemptKey).push(row);
  }

  const canonicalRows = [];
  for (const attemptRows of attempts.values()) {
    const canonicals = attemptRows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
    if (canonicals.length !== 1 || canonicals[0].canonicalRowID !== canonicals[0].id) {
      throw new Error('Logical attempt requires exactly one self-owned canonical row');
    }
    const canonical = canonicals[0];
    canonicalRows.push(canonical);
    for (const row of attemptRows) {
      if (
        (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') ||
        (row.reconciliationStatus === 'duplicate' && row.canonicalRowID !== canonical.id)
      ) {
        throw new Error('Invalid logical attempt canonical linkage');
      }
    }
  }
  return canonicalRows;
}

function verifyCurrentRow(canonicalRows, currentResult, expected) {
  if (
    currentResult?.action !== 'verified' ||
    currentResult.logicalJobKey !== expected?.logicalJobKey ||
    currentResult.attemptKey !== expected.attemptKey ||
    currentResult.requestKey !== expected.requestKey
  ) {
    throw new Error('Invalid verified callback result');
  }
  const current = canonicalRows.find(({ attemptKey }) => attemptKey === expected.attemptKey);
  if (!current || CALLBACK_IDENTITY_FIELDS.some((field) => current[field] !== expected[field])) {
    throw new Error('Post-callback current row identity mismatch');
  }
  if (
    current.status !== expected.desiredStatus ||
    current.consumedAtIso !== expected.consumedAtIso ||
    current.dialogue !== expected.dialogue ||
    current.language !== expected.language ||
    current.errorCode !== expected.errorCode ||
    current.nextRetryAtIso !== expected.nextRetryAtIso
  ) {
    throw new Error('Post-callback current row state mismatch');
  }
  return current;
}

function result(action, current, expected) {
  const accepted = action === 'accepted';
  return {
    action,
    responseClass: accepted ? 'accepted' : 'duplicate',
    httpStatus: accepted ? 202 : 200,
    attemptKey: expected.attemptKey,
    requestKey: expected.requestKey,
    logicalJobKey: expected.logicalJobKey,
    resultStatus: current.status,
    triggerPresentation: accepted && current.status === 'completed',
    triggerCoordinator: accepted,
  };
}

function verifyLogicalWinner(rows, currentResult, expected) {
  const canonicalRows = validateLogicalRows(rows, expected);
  const current = verifyCurrentRow(canonicalRows, currentResult, expected);
  if (current.status !== 'completed') return result('accepted', current, expected);

  const completedRows = canonicalRows.filter(({ status }) => status === 'completed');
  for (const row of completedRows) {
    if (typeof row.dialogue !== 'string' || row.dialogue.trim() === '' || !isExactIso(row.consumedAtIso)) {
      throw new Error('Invalid completed logical job row');
    }
  }
  const [winner] = [...completedRows].sort(compareCompleted);
  if (!winner) throw new Error('Completed logical job winner not found');
  return result(winner.id === current.id ? 'accepted' : 'duplicate', current, expected);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { verifyLogicalWinner };
}

if (typeof $input !== 'undefined') {
  return [{
    json: verifyLogicalWinner(
      $input.all().map(({ json }) => json),
      $('Verify Callback Result').first().json,
      $('Classify Claim').first().json,
    ),
  }];
}
