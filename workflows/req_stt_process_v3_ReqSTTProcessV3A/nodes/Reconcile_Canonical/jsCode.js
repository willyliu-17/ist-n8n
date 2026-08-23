const CHECKPOINT_FIELDS = Object.freeze([
  'submittedAtIso', 'callbackDeadlineAtIso', 'consumedAtIso', 'dialogue',
  'transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso',
]);
const RECONCILIATION_STATUSES = new Set(['pending', 'canonical', 'duplicate']);

function compareRows(left, right) {
  if (left.createdAt < right.createdAt) return -1;
  if (left.createdAt > right.createdAt) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function hasCheckpoint(row) {
  return CHECKPOINT_FIELDS.some((field) => row[field] !== undefined && row[field] !== null && row[field] !== '');
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Attempt row not found');
  const attemptKey = rows[0].attemptKey;
  const requestKey = rows[0].requestKey;
  if (typeof attemptKey !== 'string' || attemptKey === '') throw new Error('Invalid attempt key');
  if (typeof requestKey !== 'string' || requestKey === '') throw new Error('Invalid request key');
  for (const row of rows) {
    for (const field of ['id', 'createdAt', 'updatedAt']) {
      if (typeof row[field] !== 'string' || row[field] === '') throw new Error(`Invalid required system field: ${field}`);
    }
    if (row.attemptKey !== attemptKey || row.requestKey !== requestKey) throw new Error('Invalid same-key row set');
    if (!RECONCILIATION_STATUSES.has(row.reconciliationStatus)) throw new Error('Invalid reconciliation status');
    if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== row.id) throw new Error('Canonical row must point to itself');
    if (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') throw new Error('Pending row must not have a canonical row ID');
    if (row.reconciliationStatus === 'duplicate' && (typeof row.canonicalRowID !== 'string' || row.canonicalRowID === '')) {
      throw new Error('Duplicate row must point to a canonical row');
    }
  }
}

function mutation(row, winnerRowID, desiredReconciliationStatus) {
  return {
    id: row.id,
    attemptKey: row.attemptKey,
    expectedReconciliationStatus: row.reconciliationStatus,
    expectedCanonicalRowID: row.canonicalRowID,
    desiredReconciliationStatus,
    desiredCanonicalRowID: winnerRowID,
  };
}

function planCanonicalReconciliation(rows) {
  validateRows(rows);
  const canonicalRows = rows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicalRows.length > 1) {
    if (rows.some(hasCheckpoint)) {
      return {
        action: 'manual_review',
        reason: 'multiple_canonical_checkpoint_conflict',
        mutations: canonicalRows.map((row) => ({
          ...mutation(row, row.id, 'canonical'),
          expectedStatus: row.status,
          desiredStatus: 'manual_review',
        })),
      };
    }
    const [winner, ...losers] = [...canonicalRows].sort(compareRows);
    return { action: 'reconcile', winnerRowID: winner.id, mutations: losers.map((row) => mutation(row, winner.id, 'duplicate')) };
  }
  if (canonicalRows.length === 1) {
    const canonical = canonicalRows[0];
    const mutations = rows
      .filter((row) => row.id !== canonical.id)
      .filter((row) => row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== canonical.id)
      .map((row) => mutation(row, canonical.id, 'duplicate'));
    return mutations.length === 0
      ? { action: 'ready', winnerRowID: canonical.id, canonical, mutations: [] }
      : { action: 'reconcile', winnerRowID: canonical.id, mutations };
  }
  const [winner] = [...rows].sort(compareRows);
  return {
    action: 'reconcile',
    winnerRowID: winner.id,
    mutations: rows.map((row) => mutation(row, winner.id, row.id === winner.id ? 'canonical' : 'duplicate')),
  };
}

function verifyFrozenConflict(rows, expectedMutations) {
  validateRows(rows);
  if (!Array.isArray(expectedMutations) || expectedMutations.length < 2) throw new Error('Invalid conflict plan');
  const expectedIDs = [...new Set(expectedMutations.map(({ id }) => id))].sort();
  const canonicalRows = rows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicalRows.length !== expectedIDs.length) throw new Error('Canonical conflict set changed');
  for (const row of canonicalRows) {
    if (!expectedIDs.includes(row.id) || row.canonicalRowID !== row.id || row.status !== 'manual_review'
      || row.manualReviewReason !== 'multiple_canonical_checkpoint_conflict'
      || typeof row.manualReviewAtIso !== 'string' || !Number.isFinite(Date.parse(row.manualReviewAtIso))) {
      throw new Error('Canonical conflict was not frozen exactly');
    }
  }
  return { manualReview: true, reason: 'multiple_canonical_checkpoint_conflict' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CHECKPOINT_FIELDS, planCanonicalReconciliation, verifyFrozenConflict };
}

if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json }) => json);
  if ($('Freeze Conflict Plan').isExecuted) {
    const expected = $('Freeze Conflict Plan').all().map(({ json }) => json);
    return [{ json: verifyFrozenConflict(rows, expected) }];
  }
  const plan = planCanonicalReconciliation(rows);
  if (plan.action === 'ready') return [{ json: { ...plan.canonical, reconciliationAction: 'ready' } }];
  return plan.mutations.map((json) => ({ json: { ...json, reconciliationAction: plan.action, manualReviewReason: plan.reason || '' } }));
}
