const ATTEMPT_CHECKPOINT_FIELDS = Object.freeze([
  'submittedAtIso', 'callbackDeadlineAtIso', 'consumedAtIso', 'dialogue',
  'transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso',
]);
const SUMMARY_CHECKPOINT_FIELDS = Object.freeze([
  'inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS',
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

function immutableAttemptMatches(row, expected) {
  for (const field of ['attemptKey', 'logicalJobKey', 'requestKey', 'requestType', 'attempt', 'role', 'streamID', 'mode', 'durationMinutes', 'streamContextJson', 'channel', 'threadTS', 'processingMessageTS']) {
    if (row[field] !== expected[field]) throw new Error(`Immutable attempt payload conflict: ${field}`);
  }
}

function validateRows(rows, expected) {
  const requestKey = rows[0].requestKey;
  if (typeof requestKey !== 'string' || !requestKey) throw new Error('Invalid attempt request key');
  for (const row of rows) {
    for (const field of ['id', 'createdAt', 'updatedAt']) {
      if (typeof row[field] !== 'string' || !row[field]) throw new Error(`Invalid required system field: ${field}`);
    }
    if (row.attemptKey !== expected.attemptKey) throw new Error('Invalid same-attempt row set');
    if (typeof row.requestKey !== 'string' || !row.requestKey) throw new Error('Invalid attempt request key');
    if (row.requestKey !== requestKey) throw new Error('Attempt request key mismatch');
    if (!RECONCILIATION_STATUSES.has(row.reconciliationStatus)) throw new Error('Invalid attempt reconciliation status');
    if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== row.id) throw new Error('Canonical row does not point to itself');
    if (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') throw new Error('Pending row must not have a canonical row ID');
    if (row.reconciliationStatus === 'duplicate' && (typeof row.canonicalRowID !== 'string' || !row.canonicalRowID)) {
      throw new Error('Duplicate row must have a canonical row ID');
    }
    immutableAttemptMatches(row, expected);
  }
}

function validateSummaryRows(rows, summaryRows) {
  if (!Array.isArray(summaryRows)) throw new Error('Invalid summary row set');
  const requestKey = rows[0].requestKey;
  const meaningful = summaryRows.filter((row) => row && Object.keys(row).length > 0);
  for (const row of meaningful) {
    if (row.requestKey !== requestKey) throw new Error('Summary request key mismatch');
  }
  return meaningful;
}

function mutation(row, winnerRowID, desiredReconciliationStatus) {
  return {
    id: row.id,
    attemptKey: row.attemptKey,
    expectedStatus: row.status,
    expectedReconciliationStatus: row.reconciliationStatus,
    expectedCanonicalRowID: row.canonicalRowID,
    desiredReconciliationStatus,
    desiredCanonicalRowID: winnerRowID,
  };
}

function planAttemptReconciliation(rows, expected, summaryRows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return { action: 'insert', expected };
  validateRows(rows, expected);
  const summaries = validateSummaryRows(rows, summaryRows);
  const canonicals = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  if (canonicals.length > 1) {
    const checkpointed = rows.some((row) => hasCheckpoint(row, ATTEMPT_CHECKPOINT_FIELDS))
      || summaries.some((row) => hasCheckpoint(row, SUMMARY_CHECKPOINT_FIELDS));
    if (checkpointed) {
      return {
        action: 'manual_review',
        mutations: canonicals.map((row) => ({ ...mutation(row, row.id, 'canonical'), desiredStatus: 'manual_review' })),
      };
    }
    const [winner, ...losers] = [...canonicals].sort(compareRows);
    return { action: 'reconcile', winnerRowID: winner.id, mutations: losers.map((row) => mutation(row, winner.id, 'duplicate')) };
  }
  if (canonicals.length === 1) {
    const canonical = canonicals[0];
    const mutations = rows.filter((row) => row.id !== canonical.id)
      .filter((row) => row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== canonical.id)
      .map((row) => mutation(row, canonical.id, 'duplicate'));
    return mutations.length
      ? { action: 'reconcile', winnerRowID: canonical.id, mutations }
      : { action: 'ready', canonical, winnerRowID: canonical.id, mutations: [] };
  }
  const [winner] = [...rows].sort(compareRows);
  return {
    action: 'reconcile',
    winnerRowID: winner.id,
    mutations: rows.map((row) => mutation(row, winner.id, row.id === winner.id ? 'canonical' : 'duplicate')),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ATTEMPT_CHECKPOINT_FIELDS, SUMMARY_CHECKPOINT_FIELDS, immutableAttemptMatches, planAttemptReconciliation };
}

if (typeof $input !== 'undefined') {
  const expected = $('Attempt Loop').first().json;
  const rows = $('Read Attempt Key Rows').all().map(({ json }) => json).filter((row) => row.id);
  const summaryRows = $input.all().map(({ json }) => json).filter((row) => row.id);
  const plan = planAttemptReconciliation(rows, expected, summaryRows);
  if (plan.action === 'ready') return [{ json: { ...plan.canonical, reconciliationAction: 'ready' } }];
  if (plan.action === 'insert') return [{ json: { ...expected, reconciliationAction: 'insert' } }];
  return plan.mutations.map((json) => ({ json: { ...json, reconciliationAction: plan.action } }));
}
