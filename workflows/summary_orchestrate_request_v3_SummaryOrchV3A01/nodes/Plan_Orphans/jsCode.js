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

function validateRows(rows) {
  const attemptKey = rows[0].attemptKey;
  const requestKey = rows[0].requestKey;
  if (typeof attemptKey !== 'string' || !attemptKey) throw new Error('Invalid orphan attempt key');
  if (typeof requestKey !== 'string' || !requestKey) throw new Error('Invalid orphan request key');
  for (const row of rows) {
    for (const field of ['id', 'createdAt', 'updatedAt']) {
      if (typeof row[field] !== 'string' || !row[field]) throw new Error(`Invalid required system field: ${field}`);
    }
    if (row.attemptKey !== attemptKey) throw new Error('Invalid same-key orphan row set');
    if (row.requestKey !== requestKey) throw new Error('Orphan attempt request key mismatch');
    if (!RECONCILIATION_STATUSES.has(row.reconciliationStatus)) throw new Error('Invalid orphan reconciliation status');
    if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== row.id) throw new Error('Canonical orphan row does not point to itself');
    if (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') throw new Error('Pending orphan row must not have a canonical row ID');
    if (row.reconciliationStatus === 'duplicate' && (typeof row.canonicalRowID !== 'string' || !row.canonicalRowID)) {
      throw new Error('Duplicate orphan row must have a canonical row ID');
    }
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

function mutation(row, winnerRowID, desiredReconciliationStatus, desiredStatus = row.status) {
  return {
    id: row.id,
    attemptKey: row.attemptKey,
    requestKey: row.requestKey,
    expectedStatus: row.status,
    expectedReconciliationStatus: row.reconciliationStatus,
    expectedCanonicalRowID: row.canonicalRowID,
    desiredStatus,
    desiredReconciliationStatus,
    desiredCanonicalRowID: winnerRowID,
  };
}

function deletion(row) {
  return {
    ...mutation(row, row.canonicalRowID, row.reconciliationStatus),
    expectedUpdatedAt: row.updatedAt,
    expectedSubmittedAtIso: row.submittedAtIso || '',
    expectedCallbackDeadlineAtIso: row.callbackDeadlineAtIso || '',
    expectedConsumedAtIso: row.consumedAtIso || '',
    expectedDialogue: row.dialogue || '',
    expectedTranscriptUploadID: row.transcriptUploadID || '',
    expectedAnalysisUploadID: row.analysisUploadID || '',
    expectedProcessingMessageUpdatedAtIso: row.processingMessageUpdatedAtIso || '',
  };
}

function planOrphanGroup(rows, summaryRows) {
  validateRows(rows);
  const summaries = validateSummaryRows(rows, summaryRows);
  const canonicals = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  const attemptCheckpointed = rows.some((row) => hasCheckpoint(row, ATTEMPT_CHECKPOINT_FIELDS));
  const summaryCheckpointed = summaries.some((row) => hasCheckpoint(row, SUMMARY_CHECKPOINT_FIELDS));

  if (canonicals.length > 1 && (attemptCheckpointed || summaryCheckpointed)) {
    return {
      action: 'manual_review',
      mutations: canonicals.map((row) => mutation(row, row.id, 'canonical', 'manual_review')),
    };
  }

  if (canonicals.length > 1) {
    const [winner, ...losers] = [...canonicals].sort(compareRows);
    return { action: 'reconcile', mutations: losers.map((row) => mutation(row, winner.id, 'duplicate')) };
  }

  if (canonicals.length === 0) {
    const [winner] = [...rows].sort(compareRows);
    return {
      action: 'reconcile',
      mutations: rows.map((row) => mutation(row, winner.id, row.id === winner.id ? 'canonical' : 'duplicate')),
    };
  }

  const canonical = canonicals[0];
  const reconciliationMutations = rows
    .filter((row) => row.id !== canonical.id)
    .filter((row) => row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== canonical.id)
    .map((row) => mutation(row, canonical.id, 'duplicate'));
  if (reconciliationMutations.length) return { action: 'reconcile', mutations: reconciliationMutations };
  if (attemptCheckpointed || summaryCheckpointed) {
    return { action: 'manual_review', mutations: [mutation(canonical, canonical.id, 'canonical', 'manual_review')] };
  }
  return { action: 'delete', mutations: rows.map(deletion) };
}

function planOrphans(rows, expectedAttemptKeys, summaryRows = []) {
  const expected = new Set(expectedAttemptKeys);
  const groups = new Map();
  for (const row of rows) {
    if (!row.id || expected.has(row.attemptKey)) continue;
    if (!groups.has(row.attemptKey)) groups.set(row.attemptKey, []);
    groups.get(row.attemptKey).push(row);
  }
  if (!groups.size) return { action: 'ready', mutations: [] };
  const [attemptKey] = [...groups.keys()].sort();
  const plan = planOrphanGroup(groups.get(attemptKey), summaryRows);
  return {
    ...plan,
    mutations: plan.mutations.map((item) => ({ ...item, orphanAction: plan.action })),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ATTEMPT_CHECKPOINT_FIELDS, SUMMARY_CHECKPOINT_FIELDS, planOrphans };
}

if (typeof $input !== 'undefined') {
  const rows = $('Read Existing Request Attempts').all().map(({ json }) => json).filter((row) => row.id);
  const summaryRows = $input.all().map(({ json }) => json).filter((row) => row.id);
  const keys = JSON.parse($('Normalize Request').first().json.expectedLogicalJobKeysJson).map((key) => `${key}:1`);
  const plan = planOrphans(rows, keys, summaryRows);
  if (plan.action === 'ready') return [{ json: { orphanAction: 'ready' } }];
  return plan.mutations.map((json) => ({ json }));
}
