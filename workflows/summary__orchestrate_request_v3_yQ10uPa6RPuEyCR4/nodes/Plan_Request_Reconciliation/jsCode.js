const SUMMARY_FIELDS = Object.freeze([
  'requestKey', 'requestType', 'status', 'creationLeaseOwner', 'reconciliationStatus',
  'canonicalRowID', 'creationLeaseUntilIso', 'orderedStreamsJson', 'existingDialoguesJson',
  'expectedLogicalJobKeysJson', 'channel', 'threadTS', 'coverageStatus',
  'availableRolesJson', 'missingRolesJson', 'failedLogicalJobKeysJson', 'leaseOwner',
  'leaseUntilIso', 'summaryAttempt', 'nextRetryAtIso', 'errorCode', 'inferenceResultJson',
  'summaryMarkdown', 'summaryMessageTS', 'summaryUploadID', 'manualReviewReason',
  'manualReviewAtIso', 'manualReviewResolution', 'manualReviewOriginalStage',
  'manualResolutionWinnerRowID', 'manualResolutionDecisionID', 'createdAtIso', 'updatedAtIso',
]);
const IMMUTABLE_FIELDS = Object.freeze([
  'requestKey', 'requestType', 'orderedStreamsJson', 'existingDialoguesJson',
  'expectedLogicalJobKeysJson', 'channel', 'threadTS',
]);
const SUMMARY_CHECKPOINT_FIELDS = Object.freeze([
  'inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS',
]);
const ORIGINAL_STAGE_ALLOWLIST = new Set(['ready', 'summary_dispatching', 'summary_retry_pending', 'completed']);
const RECONCILIATION_STATUSES = new Set(['pending', 'canonical', 'duplicate']);

function systemRowID(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function compareRows(left, right) {
  if (left.createdAt < right.createdAt) return -1;
  if (left.createdAt > right.createdAt) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function buildSummaryRow(normalized, executionID, nowIso = new Date().toISOString()) {
  if (typeof executionID !== 'string' || executionID === '') throw new Error('executionID is required');
  const until = new Date(Date.parse(nowIso) + 24 * 60 * 60 * 1000).toISOString();
  const row = {
    requestKey: normalized.requestKey, requestType: normalized.requestType, status: 'creating',
    creationLeaseOwner: executionID, reconciliationStatus: 'pending', canonicalRowID: '',
    creationLeaseUntilIso: until, orderedStreamsJson: normalized.orderedStreamsJson,
    existingDialoguesJson: normalized.existingDialoguesJson,
    expectedLogicalJobKeysJson: normalized.expectedLogicalJobKeysJson, channel: normalized.channel,
    threadTS: normalized.threadTS, coverageStatus: 'pending', availableRolesJson: '[]',
    missingRolesJson: '[]', failedLogicalJobKeysJson: '[]', leaseOwner: '', leaseUntilIso: '',
    summaryAttempt: 0, nextRetryAtIso: '', errorCode: '', inferenceResultJson: '',
    summaryMarkdown: '', summaryMessageTS: '', summaryUploadID: '', manualReviewReason: '',
    manualReviewAtIso: '', manualReviewResolution: '', manualReviewOriginalStage: '',
    manualResolutionWinnerRowID: '', manualResolutionDecisionID: '', createdAtIso: nowIso,
    updatedAtIso: nowIso,
  };
  if (Object.keys(row).length !== SUMMARY_FIELDS.length
    || SUMMARY_FIELDS.some((field, index) => Object.keys(row)[index] !== field)) throw new Error('Summary request schema drift');
  return row;
}

function rowsFromItems(items) {
  return items.map((item) => item?.json || item).filter((row) => row && systemRowID(row.id));
}

function validateRows(rows, requestKey) {
  for (const row of rows) {
    if (!systemRowID(row.id)) throw new Error('Invalid request system field: id');
    for (const field of ['createdAt', 'updatedAt']) {
      if (typeof row[field] !== 'string' || row[field] === '') throw new Error(`Invalid request system field: ${field}`);
    }
    if (row.requestKey !== requestKey) throw new Error('Request key mismatch');
    if (!RECONCILIATION_STATUSES.has(row.reconciliationStatus)) throw new Error('Invalid request reconciliation status');
    if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== String(row.id)) throw new Error('Canonical request must point to itself');
    if (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') throw new Error('Pending request must not point to canonical');
    if (row.reconciliationStatus === 'duplicate' && (typeof row.canonicalRowID !== 'string' || row.canonicalRowID === '')) {
      throw new Error('Duplicate request must point to canonical');
    }
  }
}

function assertImmutable(row, normalized) {
  for (const field of IMMUTABLE_FIELDS) {
    if (row[field] !== normalized[field]) throw new Error(`Immutable request payload conflict: ${field}`);
  }
}

function mutation(row, winnerRowID, desiredReconciliationStatus) {
  return {
    id: row.id, requestKey: row.requestKey, expectedStatus: row.status,
    expectedReconciliationStatus: row.reconciliationStatus,
    expectedCanonicalRowID: row.canonicalRowID, desiredReconciliationStatus,
    desiredCanonicalRowID: String(winnerRowID),
  };
}

function planRequestReconciliation(rows, normalized) {
  validateRows(rows, normalized.requestKey);
  if (rows.length === 0) return { action: 'insert' };
  for (const row of rows) assertImmutable(row, normalized);
  const canonicalRows = rows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicalRows.length > 1) {
    if (rows.some((row) => SUMMARY_CHECKPOINT_FIELDS.some((field) => row[field] !== undefined && row[field] !== null && row[field] !== ''))) {
      for (const row of canonicalRows) {
        if (!ORIGINAL_STAGE_ALLOWLIST.has(row.status)) throw new Error('Checkpoint conflict has invalid original stage');
      }
      return {
        action: 'manual_review',
        reason: 'multiple_canonical_checkpoint_conflict',
        mutations: canonicalRows.map((row) => ({ ...mutation(row, row.id, 'canonical'), manualReviewOriginalStage: row.status })),
      };
    }
    const [winner, ...losers] = [...canonicalRows].sort(compareRows);
    assertImmutable(winner, normalized);
    return { action: 'reconcile', winnerRowID: winner.id, mutations: losers.map((row) => mutation(row, winner.id, 'duplicate')) };
  }
  if (canonicalRows.length === 1) {
    const canonical = canonicalRows[0];
    assertImmutable(canonical, normalized);
    const mutations = rows.filter((row) => row.id !== canonical.id)
      .filter((row) => row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(canonical.id))
      .map((row) => mutation(row, canonical.id, 'duplicate'));
    return mutations.length ? { action: 'reconcile', winnerRowID: canonical.id, mutations }
      : { action: 'ready', winnerRowID: canonical.id, canonical, mutations: [] };
  }
  const [winner] = [...rows].sort(compareRows);
  assertImmutable(winner, normalized);
  return {
    action: 'reconcile', winnerRowID: winner.id,
    mutations: rows.map((row) => mutation(row, winner.id, row.id === winner.id ? 'canonical' : 'duplicate')),
  };
}

function planCreationLease(canonical, executionID, nowIso = new Date().toISOString()) {
  if (canonical.status !== 'creating') return { action: 'accepted', canonical };
  if (canonical.reconciliationStatus !== 'canonical' || canonical.canonicalRowID !== String(canonical.id)) throw new Error('Creation lease requires canonical request');
  const owner = canonical.creationLeaseOwner || '';
  const until = canonical.creationLeaseUntilIso || '';
  const parsedUntil = until === '' ? Number.NEGATIVE_INFINITY : Date.parse(until);
  if (until !== '' && !Number.isFinite(parsedUntil)) throw new Error('Invalid creation lease expiry');
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) throw new Error('Invalid current time');
  if (owner === executionID && parsedUntil > now) return { action: 'resume', canonical };
  if (owner !== '' && owner !== executionID && parsedUntil > now) return { action: 'blocked', canonical };
  return {
    action: 'claim', id: canonical.id, requestKey: canonical.requestKey,
    expectedCreationLeaseOwner: owner, expectedCreationLeaseUntilIso: until,
  };
}

function verifyCreationOwner(rows, requestKey, executionID, nowIso = new Date().toISOString()) {
  validateRows(rows, requestKey);
  const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicals.length !== 1) throw new Error('Expected exactly one canonical request');
  const row = canonicals[0];
  if (row.status !== 'creating' || row.creationLeaseOwner !== executionID
    || !Number.isFinite(Date.parse(row.creationLeaseUntilIso))
    || Date.parse(row.creationLeaseUntilIso) <= Date.parse(nowIso)) throw new Error('Current execution does not own creation lease');
  return row;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IMMUTABLE_FIELDS, ORIGINAL_STAGE_ALLOWLIST, SUMMARY_CHECKPOINT_FIELDS, SUMMARY_FIELDS,
    assertImmutable, buildSummaryRow, planCreationLease, planRequestReconciliation,
    rowsFromItems, verifyCreationOwner,
  };
}

if (typeof $input !== 'undefined') {
  const normalized = $('Normalize Request').first().json;
  const rows = rowsFromItems($input.all());
  const plan = planRequestReconciliation(rows, normalized);
  if (plan.action === 'ready') return [{ json: { ...plan.canonical, reconciliationAction: 'ready' } }];
  if (plan.action === 'insert') return [{ json: { ...buildSummaryRow(normalized, $execution.id), reconciliationAction: 'insert' } }];
  return plan.mutations.map((json) => ({ json: { ...json, reconciliationAction: plan.action, manualReviewReason: plan.reason || '' } }));
}
