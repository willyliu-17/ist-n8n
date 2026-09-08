function verifyRequestConflict(rows, expected) {
  const ids = new Set(expected.map((item) => item.id));
  const frozen = rows.filter((row) => ids.has(row.id));
  if (frozen.length !== ids.size || frozen.some((row) => row.status !== 'manual_review'
    || row.reconciliationStatus !== 'canonical' || row.canonicalRowID !== String(row.id)
    || row.manualReviewReason !== 'multiple_canonical_checkpoint_conflict'
    || !['ready', 'summary_dispatching', 'summary_retry_pending', 'completed'].includes(row.manualReviewOriginalStage))) {
    throw new Error('Request checkpoint conflict was not frozen exactly');
  }
  return { verified: true };
}

function verifyAttemptConflict(rows, expected) {
  const ids = new Set(expected.map((item) => item.id));
  const frozen = rows.filter((row) => ids.has(row.id));
  if (frozen.length !== ids.size || frozen.some((row) => row.status !== 'manual_review'
    || row.reconciliationStatus !== 'canonical' || row.canonicalRowID !== String(row.id)
    || row.manualReviewReason !== 'multiple_canonical_checkpoint_conflict')) {
    throw new Error('Attempt checkpoint conflict was not frozen exactly');
  }
  return { verified: true };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { verifyAttemptConflict, verifyRequestConflict };

if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json }) => json).filter((row) => row.id);
  if ($('Freeze Request Plan').isExecuted) {
    verifyRequestConflict(rows, $('Freeze Request Plan').all().map(({ json }) => json));
  } else {
    verifyAttemptConflict(rows, $('Freeze Attempt Plan').all().map(({ json }) => json));
  }
  return [];
}
