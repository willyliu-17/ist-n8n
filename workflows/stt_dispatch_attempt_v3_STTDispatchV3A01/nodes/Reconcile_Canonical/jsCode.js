const ATTEMPT_CHECKPOINT_FIELDS = Object.freeze([
  'submittedAtIso',
  'callbackDeadlineAtIso',
  'consumedAtIso',
  'dialogue',
  'transcriptUploadID',
  'analysisUploadID',
  'processingMessageUpdatedAtIso',
]);

const SUMMARY_CHECKPOINT_FIELDS = Object.freeze([
  'inferenceResultJson',
  'summaryMarkdown',
  'summaryUploadID',
  'summaryMessageTS',
]);
const RECONCILIATION_STATUSES = new Set(['pending', 'canonical', 'duplicate']);

function compareRows(left, right) {
  if (left.createdAt < right.createdAt) return -1;
  if (left.createdAt > right.createdAt) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function hasCheckpoint(row, fields) {
  return fields.some((field) => row[field] !== undefined && row[field] !== null && row[field] !== '');
}

function systemRowID(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function mutation(row, winnerRowID, desiredReconciliationStatus) {
  return {
    id: row.id,
    attemptKey: row.attemptKey,
    expectedReconciliationStatus: row.reconciliationStatus || '',
    expectedCanonicalRowID: row.canonicalRowID || '',
    desiredReconciliationStatus,
    desiredCanonicalRowID: String(winnerRowID),
  };
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Attempt row not found');
  const attemptKey = rows[0].attemptKey;
  const requestKey = rows[0].requestKey;
  if (typeof attemptKey !== 'string' || !attemptKey) throw new Error('Invalid attempt key');
  if (typeof requestKey !== 'string' || !requestKey) throw new Error('Invalid attempt request key');
  for (const row of rows) {
    if (!systemRowID(row.id)) throw new Error('Invalid required system field: id');
    for (const field of ['createdAt', 'updatedAt']) {
      if (typeof row[field] !== 'string' || !row[field]) throw new Error(`Invalid required system field: ${field}`);
    }
    if (row.attemptKey !== attemptKey) throw new Error('Invalid same-key row set');
    if (typeof row.requestKey !== 'string' || !row.requestKey) throw new Error('Invalid attempt request key');
    if (row.requestKey !== requestKey) throw new Error('Attempt request key mismatch');
    if (!RECONCILIATION_STATUSES.has(row.reconciliationStatus)) throw new Error('Invalid reconciliation status');
    if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== String(row.id)) {
      throw new Error('Canonical row does not point to itself');
    }
    if (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') {
      throw new Error('Pending row must not have a canonical row ID');
    }
    if (
      row.reconciliationStatus === 'duplicate' &&
      (typeof row.canonicalRowID !== 'string' || !row.canonicalRowID)
    ) {
      throw new Error('Duplicate row must have a canonical row ID');
    }
  }
}

function validateSummaryRows(attemptRows, summaryRows) {
  if (!Array.isArray(summaryRows)) throw new Error('Invalid summary row set');
  const requestKey = attemptRows[0].requestKey;
  if (typeof requestKey !== 'string' || !requestKey) throw new Error('Invalid attempt request key');
  const meaningfulRows = summaryRows.filter((row) => row && Object.keys(row).length > 0);
  for (const row of meaningfulRows) {
    if (row.requestKey !== requestKey) throw new Error('Summary request key mismatch');
  }
  return meaningfulRows;
}

function planCanonicalReconciliation(attemptRows, summaryRows = []) {
  validateRows(attemptRows);
  const meaningfulSummaryRows = validateSummaryRows(attemptRows, summaryRows);
  const canonicalRows = attemptRows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');

  if (canonicalRows.length > 1) {
    const hasAttemptCheckpoint = attemptRows.some((row) => hasCheckpoint(row, ATTEMPT_CHECKPOINT_FIELDS));
    const hasSummaryCheckpoint = meaningfulSummaryRows.some((row) => hasCheckpoint(row, SUMMARY_CHECKPOINT_FIELDS));
    if (hasAttemptCheckpoint || hasSummaryCheckpoint) {
      for (const row of canonicalRows) {
        if (row.canonicalRowID !== String(row.id)) throw new Error('Canonical row does not point to itself');
      }
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
    for (const row of canonicalRows) {
        if (row.canonicalRowID !== String(row.id)) throw new Error('Canonical row does not point to itself');
    }
    return {
      action: 'reconcile',
      winnerRowID: winner.id,
      mutations: losers.map((row) => mutation(row, winner.id, 'duplicate')),
    };
  }

  if (canonicalRows.length === 1) {
    const canonical = canonicalRows[0];
    if (canonical.canonicalRowID !== String(canonical.id)) throw new Error('Canonical row does not point to itself');
    const mutations = attemptRows
      .filter((row) => row.id !== canonical.id)
      .filter((row) => row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(canonical.id))
      .map((row) => mutation(row, canonical.id, 'duplicate'));
    return mutations.length > 0
      ? { action: 'reconcile', winnerRowID: canonical.id, mutations }
      : { action: 'ready', winnerRowID: canonical.id, canonical, mutations: [] };
  }

  const [winner] = [...attemptRows].sort(compareRows);
  return {
    action: 'reconcile',
    winnerRowID: winner.id,
    mutations: attemptRows.map((row) => mutation(
      row,
      winner.id,
      row.id === winner.id ? 'canonical' : 'duplicate',
    )),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ATTEMPT_CHECKPOINT_FIELDS,
    SUMMARY_CHECKPOINT_FIELDS,
    planCanonicalReconciliation,
  };
}

if (typeof $input !== 'undefined') {
  const attemptSource = $('Re-read After Reconciliation').isExecuted
    ? $('Re-read After Reconciliation').all()
    : $('Read All Attempt Rows').all();
  const plan = planCanonicalReconciliation(
    attemptSource.map(({ json }) => json),
    $input.all().map(({ json }) => json),
  );
  if (plan.action === 'ready') {
    return [{ json: { ...plan.canonical, reconciliationAction: 'ready' } }];
  }
  return plan.mutations.map((item) => ({
    json: {
      ...item,
      reconciliationAction: plan.action,
      manualReviewReason: plan.reason || '',
    },
  }));
}
