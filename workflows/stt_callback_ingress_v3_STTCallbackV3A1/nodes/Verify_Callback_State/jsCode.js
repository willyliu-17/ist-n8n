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

function isExactIso(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function requireCanonical(rows) {
  if (!Array.isArray(rows)) throw new Error('Invalid callback row set');
  const canonicalRows = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  if (canonicalRows.length !== 1) throw new Error('Callback state requires exactly one canonical row');
  const canonical = canonicalRows[0];
  if (canonical.canonicalRowID !== String(canonical.id)) throw new Error('Callback canonical row does not point to itself');
  return canonical;
}

function verifyCallbackState(rows, expected) {
  const canonical = requireCanonical(rows);
  if (CALLBACK_IDENTITY_FIELDS.some((field) => canonical[field] !== expected[field])) {
    throw new Error('Callback canonical identity mismatch');
  }
  const expectedApplied = (
    canonical.status === expected.desiredStatus &&
    canonical.consumedAtIso === expected.consumedAtIso &&
    canonical.dialogue === expected.dialogue &&
    canonical.language === expected.language &&
    canonical.errorCode === expected.errorCode &&
    canonical.nextRetryAtIso === expected.nextRetryAtIso
  );
  if (expectedApplied) {
    return {
      action: 'verified',
      responseClass: 'accepted',
      httpStatus: 202,
      attemptKey: expected.attemptKey,
      requestKey: expected.requestKey,
      logicalJobKey: expected.logicalJobKey,
      resultStatus: canonical.status,
      triggerPresentation: canonical.status === 'completed',
      triggerCoordinator: true,
    };
  }
  const remainsUnconsumed = (
    canonical.status === expected.expectedStatus &&
    canonical.consumedAtIso === '' &&
    canonical.callbackTokenHash === expected.callbackTokenHash &&
    (expected.expectedStatus !== 'manual_review' || canonical.manualReviewResolution === '')
  );
  if (remainsUnconsumed) {
    return {
      action: 'conflict',
      responseClass: 'conflict',
      httpStatus: 409,
      attemptKey: expected.attemptKey,
      requestKey: expected.requestKey,
      logicalJobKey: expected.logicalJobKey,
      reason: 'callback_result_patch_unconfirmed',
      triggerPresentation: false,
      triggerCoordinator: false,
    };
  }
  throw new Error('Callback state mismatch');
}

function verifyFrozenConflict(rows, expectedItems) {
  if (!Array.isArray(rows) || !Array.isArray(expectedItems) || expectedItems.length < 2) {
    throw new Error('Invalid frozen conflict inputs');
  }
  const expectedIds = expectedItems.map(({ id }) => id);
  if (expectedIds.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) || new Set(expectedIds).size !== expectedIds.length) {
    throw new Error('Invalid frozen conflict IDs');
  }
  const canonicalRows = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  if (
    canonicalRows.length !== expectedIds.length ||
    expectedIds.some((id) => !canonicalRows.some((row) => row.id === id))
  ) {
    throw new Error('Frozen conflict is missing an expected canonical row');
  }
  for (const row of canonicalRows) {
    if (
      row.canonicalRowID !== String(row.id) || row.status !== 'manual_review' ||
      row.manualReviewReason !== 'multiple_canonical_checkpoint_conflict' ||
      !isExactIso(row.manualReviewAtIso)
    ) {
      throw new Error('Frozen conflict state mismatch');
    }
  }
  return {
    action: 'verified_conflict',
    responseClass: 'conflict',
    httpStatus: 409,
    attemptKey: canonicalRows[0].attemptKey,
    requestKey: canonicalRows[0].requestKey,
    logicalJobKey: canonicalRows[0].logicalJobKey,
    reason: 'multiple_canonical_checkpoint_conflict',
    canonicalRowIDs: expectedIds,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { verifyCallbackState, verifyFrozenConflict };
}

if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json }) => json);
  if ($('Freeze Canonical Conflict').isExecuted) {
    const expectedItems = $('Freeze Conflict Plan').all().map(({ json }) => json);
    return [{ json: verifyFrozenConflict(rows, expectedItems) }];
  }
  return [{ json: verifyCallbackState(rows, $('Classify Claim').first().json) }];
}
