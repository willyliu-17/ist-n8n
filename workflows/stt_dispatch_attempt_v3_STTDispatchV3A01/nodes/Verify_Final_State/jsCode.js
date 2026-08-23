const FINAL_STATE_FIELDS = Object.freeze({
  accepted: ['submittedAtIso', 'callbackDeadlineAtIso'],
  retryable_http_failure: ['nextRetryAtIso', 'errorCode'],
  retry_exhausted: ['nextRetryAtIso', 'errorCode'],
  terminal_http_failure: ['nextRetryAtIso', 'errorCode'],
  ambiguous_transport: ['manualReviewReason', 'manualReviewAtIso', 'nextRetryAtIso'],
});
const FINAL_STATUSES = Object.freeze({
  accepted: 'waiting_callback',
  retryable_http_failure: 'retry_pending',
  retry_exhausted: 'failed',
  terminal_http_failure: 'failed',
  ambiguous_transport: 'manual_review',
});

function requireCanonical(rows) {
  if (!Array.isArray(rows)) throw new Error('Invalid final row set');
  const canonicalRows = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  if (canonicalRows.length !== 1) throw new Error('Final state requires exactly one canonical row');
  const canonical = canonicalRows[0];
  if (canonical.canonicalRowID !== canonical.id) throw new Error('Final canonical row does not point to itself');
  return canonical;
}

function expectedFields(expected) {
  const fields = FINAL_STATE_FIELDS[expected?.classification];
  if (!fields || expected.status !== FINAL_STATUSES[expected.classification]) {
    throw new Error('Invalid expected final classification');
  }
  return fields;
}

function isExpectedState(canonical, expected, fields) {
  return (
    canonical.status === expected.status &&
    canonical.dispatchLeaseOwner === '' &&
    canonical.dispatchLeaseUntilIso === '' &&
    fields.every((field) => canonical[field] === expected[field])
  );
}

function verifyFinalState(rows, expected, owner) {
  const canonical = requireCanonical(rows);
  const fields = expectedFields(expected);
  if (canonical.attemptKey !== expected.attemptKey) throw new Error('Final state attempt key mismatch');
  if (isExpectedState(canonical, expected, fields)) return { action: 'verified', canonical };

  const remainsOwnedDispatching = (
    canonical.status === 'dispatching' &&
    canonical.dispatchLeaseOwner === owner &&
    canonical.dispatchLeaseOwner === expected.dispatchLeaseOwner &&
    canonical.dispatchLeaseUntilIso === expected.dispatchLeaseUntilIso
  );
  if (!remainsOwnedDispatching) throw new Error('Final state mismatch');

  return {
    action: 'fallback',
    fallbackRowID: canonical.id,
    id: canonical.id,
    attemptKey: canonical.attemptKey,
    expectedStatus: 'dispatching',
    expectedReconciliationStatus: 'canonical',
    expectedCanonicalRowID: canonical.id,
    expectedDispatchLeaseOwner: owner,
    expectedDispatchLeaseUntilIso: canonical.dispatchLeaseUntilIso,
    desiredStatus: 'manual_review',
    manualReviewReason: 'vds_submit_result_patch_unconfirmed',
  };
}

function confirmFinalFallback(rows, expectedRowID) {
  const canonical = requireCanonical(rows);
  if (typeof expectedRowID !== 'string' || !expectedRowID || canonical.id !== expectedRowID) {
    throw new Error('Final fallback row ID mismatch');
  }
  if (
    canonical.status !== 'manual_review' ||
    canonical.manualReviewReason !== 'vds_submit_result_patch_unconfirmed' ||
    canonical.nextRetryAtIso !== '' ||
    canonical.dispatchLeaseOwner !== '' ||
    canonical.dispatchLeaseUntilIso !== ''
  ) {
    throw new Error('Final fallback state mismatch');
  }
  const timestamp = Date.parse(canonical.manualReviewAtIso);
  if (
    typeof canonical.manualReviewAtIso !== 'string' ||
    !canonical.manualReviewAtIso ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== canonical.manualReviewAtIso
  ) {
    throw new Error('Invalid fallback manual review time');
  }
  return { action: 'verified_fallback', canonical };
}

function verifyFrozenConflict(rows, expectedItems) {
  if (!Array.isArray(rows) || !Array.isArray(expectedItems) || expectedItems.length < 2) {
    throw new Error('Invalid expected competing canonical rows');
  }
  const expectedIds = expectedItems.map(({ id }) => id);
  if (expectedIds.some((id) => typeof id !== 'string' || !id) || new Set(expectedIds).size !== expectedIds.length) {
    throw new Error('Invalid expected competing canonical IDs');
  }
  const canonicalRows = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  if (
    canonicalRows.length !== expectedIds.length ||
    expectedIds.some((id) => !canonicalRows.some((row) => row.id === id))
  ) {
    throw new Error('Frozen conflict is missing an expected competing canonical row');
  }
  for (const row of canonicalRows) {
    if (
      row.canonicalRowID !== row.id ||
      row.status !== 'manual_review' ||
      row.manualReviewReason !== 'multiple_canonical_checkpoint_conflict'
    ) {
      throw new Error('Frozen conflict state mismatch');
    }
  }
  return { action: 'verified_conflict', canonicalRowIDs: expectedIds };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { confirmFinalFallback, verifyFinalState, verifyFrozenConflict };
}

if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json }) => json);
  if (!$('Classify ACK').isExecuted) {
    const expectedItems = $('Freeze Conflict Plan').all().map(({ json }) => json);
    return [{ json: verifyFrozenConflict(rows, expectedItems) }];
  }

  if ($('Patch Final State Unconfirmed').isExecuted) {
    const expectedRowID = $('Verify Final State').first().json.fallbackRowID;
    return [{ json: confirmFinalFallback(rows, expectedRowID) }];
  }
  const expected = $('Classify ACK').first().json;
  return [{
    json: verifyFinalState(rows, expected, $execution.id),
  }];
}
