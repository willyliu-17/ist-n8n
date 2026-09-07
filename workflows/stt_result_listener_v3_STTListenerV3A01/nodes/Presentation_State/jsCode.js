const PRESENTATION_MUTATION_FIELDS = Object.freeze([
  'presentationStatus',
  'presentationLeaseOwner',
  'presentationLeaseUntilIso',
  'presentationAttempt',
  'presentationNextRetryAtIso',
  'presentationErrorCode',
  'transcriptUploadID',
  'analysisUploadID',
  'processingMessageUpdatedAtIso',
  'updatedAtIso',
]);
const CLEAN_RECONCILIATION_MUTATION_FIELDS = Object.freeze([
  'reconciliationStatus', 'canonicalRowID', 'updatedAtIso',
]);
const FREEZE_MUTATION_FIELDS = Object.freeze([
  'status', 'manualReviewReason', 'manualReviewAtIso',
  'presentationLeaseOwner', 'presentationLeaseUntilIso', 'updatedAtIso',
]);
const COMPLETION_PROVENANCE_FIELDS = Object.freeze([
  'logicalJobKey', 'requestKey', 'requestType', 'role', 'streamID', 'mode',
  'durationMinutes', 'streamContextJson', 'channel', 'threadTS', 'processingMessageTS',
]);
const PRESENTATION_CHECKPOINT_FIELDS = Object.freeze([
  'transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso',
]);
const ATTEMPT_CHECKPOINT_FIELDS = Object.freeze([
  'submittedAtIso', 'callbackDeadlineAtIso', 'consumedAtIso', 'dialogue',
  'transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso',
]);
const SUMMARY_CHECKPOINT_FIELDS = Object.freeze([
  'inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS',
]);
const RECONCILIATION_STATUSES = new Set(['pending', 'canonical', 'duplicate']);
const ALLOWED_CHANNELS = new Set(['C0A4JJJKJMD', 'C09F0SYG57D']);

function strictIso(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${field}`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new Error(`Invalid ${field}`);
  return timestamp;
}

function validateAttemptKey(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error('Invalid attemptKey input');
  return value;
}

function presentationLeaseExpiry(nowIso) {
  return new Date(strictIso(nowIso, 'current time') + 24 * 60 * 60_000).toISOString();
}

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

function meaningfulRows(rows) {
  return rows.filter((row) => row && Object.keys(row).length > 0);
}

function validateRows(rows) {
  const attemptRows = meaningfulRows(Array.isArray(rows) ? rows : []);
  if (attemptRows.length === 0) throw new Error('Attempt row not found');
  const { attemptKey, requestKey } = attemptRows[0];
  validateAttemptKey(attemptKey);
  if (typeof requestKey !== 'string' || !requestKey) throw new Error('Invalid requestKey');
  for (const row of attemptRows) {
    if (!Number.isSafeInteger(row.id) || row.id <= 0) throw new Error('Invalid system field: id');
    for (const field of ['createdAt', 'updatedAt']) {
      if (typeof row[field] !== 'string' || !row[field]) throw new Error(`Invalid system field: ${field}`);
    }
    if (row.attemptKey !== attemptKey || row.requestKey !== requestKey) throw new Error('Invalid same-attempt row set');
    if (typeof row.status !== 'string' || !row.status.trim() || row.status !== row.status.trim()) throw new Error('Invalid attempt status');
    if (!RECONCILIATION_STATUSES.has(row.reconciliationStatus)) throw new Error('Invalid reconciliation status');
    if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== String(row.id)) throw new Error('Invalid canonical linkage');
    if (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') throw new Error('Invalid pending linkage');
    if (row.reconciliationStatus === 'duplicate' && (typeof row.canonicalRowID !== 'string' || !row.canonicalRowID)) {
      throw new Error('Invalid duplicate linkage');
    }
  }
  return attemptRows;
}

function validateSummaryRows(attemptRows, rows) {
  const summaries = meaningfulRows(Array.isArray(rows) ? rows : []);
  for (const row of summaries) {
    if (row.requestKey !== attemptRows[0].requestKey) throw new Error('Summary requestKey mismatch');
  }
  return summaries;
}

function reconciliationMutation(row, winnerRowID, desiredStatus) {
  return {
    id: row.id,
    attemptKey: row.attemptKey,
    expectedStatus: row.status,
    expectedReconciliationStatus: row.reconciliationStatus,
    expectedCanonicalRowID: row.canonicalRowID || '',
    desiredReconciliationStatus: desiredStatus,
    desiredCanonicalRowID: String(winnerRowID),
  };
}

function planCanonicalReconciliation(rows, summaryRows = []) {
  const attemptRows = validateRows(rows);
  const summaries = validateSummaryRows(attemptRows, summaryRows);
  const canonicals = attemptRows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicals.length > 1) {
    const checkpoint = attemptRows.some((row) => hasCheckpoint(row, ATTEMPT_CHECKPOINT_FIELDS))
      || summaries.some((row) => hasCheckpoint(row, SUMMARY_CHECKPOINT_FIELDS));
    if (checkpoint) {
      return {
        action: 'manual_review',
        reason: 'multiple_canonical_checkpoint_conflict',
        mutations: canonicals.map((row) => reconciliationMutation(row, row.id, 'canonical')),
      };
    }
    const [winner, ...losers] = [...canonicals].sort(compareRows);
    return {
      action: 'reconcile',
      winnerRowID: winner.id,
      mutations: losers.map((row) => reconciliationMutation(row, winner.id, 'duplicate')),
    };
  }
  if (canonicals.length === 1) {
    const canonical = canonicals[0];
    const mutations = attemptRows
      .filter((row) => row.id !== canonical.id)
      .filter((row) => row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(canonical.id))
      .map((row) => reconciliationMutation(row, canonical.id, 'duplicate'));
    return mutations.length
      ? { action: 'reconcile', winnerRowID: canonical.id, mutations }
      : { action: 'ready', winnerRowID: canonical.id, canonical, mutations: [] };
  }
  const [winner] = [...attemptRows].sort(compareRows);
  return {
    action: 'reconcile',
    winnerRowID: winner.id,
    mutations: attemptRows.map((row) => reconciliationMutation(
      row,
      winner.id,
      row.id === winner.id ? 'canonical' : 'duplicate',
    )),
  };
}

function requireEligibleCanonical(rows) {
  const attemptRows = validateRows(rows);
  const canonicals = attemptRows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicals.length !== 1) throw new Error('Expected exactly one canonical row');
  const canonical = canonicals[0];
  if (!['completed', 'failed', 'timed_out'].includes(canonical.status)) throw new Error('Canonical STT status is not terminal');
  if (canonical.presentationStatus !== 'pending') throw new Error('Canonical presentation is not pending');
  if (!ALLOWED_CHANNELS.has(canonical.channel)) throw new Error('Invalid presentation channel');
  if (typeof canonical.threadTS !== 'string' || !canonical.threadTS) throw new Error('Invalid threadTS');
  if (typeof canonical.processingMessageTS !== 'string' || !canonical.processingMessageTS) throw new Error('Invalid processingMessageTS');
  const presentationAttempt = Number(canonical.presentationAttempt || 0);
  if (!Number.isInteger(presentationAttempt) || presentationAttempt < 0 || presentationAttempt >= 3) {
    throw new Error('Invalid presentationAttempt');
  }
  return { ...canonical, nextPresentationAttempt: presentationAttempt + 1 };
}

function requireCanonicalOwner(rows, executionID, nowIso) {
  const attemptRows = validateRows(rows);
  const canonicals = attemptRows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicals.length !== 1) throw new Error('Expected exactly one canonical owner');
  const canonical = canonicals[0];
  if (!['completed', 'failed', 'timed_out'].includes(canonical.status)) throw new Error('Canonical is not presentation eligible');
  if (canonical.presentationStatus !== 'presenting') throw new Error('Canonical presentation is not presenting');
  if (canonical.presentationLeaseOwner !== executionID) throw new Error('Presentation lease owner mismatch');
  if (strictIso(canonical.presentationLeaseUntilIso, 'presentation lease') <= strictIso(nowIso, 'current time')) {
    throw new Error('Presentation lease expired');
  }
  if (!ALLOWED_CHANNELS.has(canonical.channel)) throw new Error('Invalid presentation channel');
  return canonical;
}

function selectNextStage(row) {
  if (row.status !== 'completed' || !String(row.dialogue || '').trim()) {
    return String(row.processingMessageUpdatedAtIso || '') ? 'complete' : 'message_update';
  }
  if (!String(row.transcriptUploadID || '')) return 'transcript';
  if (!String(row.analysisUploadID || '')) return 'analysis';
  if (!String(row.processingMessageUpdatedAtIso || '')) return 'message_update';
  return 'complete';
}

function presentationCheckpointFields(row) {
  return row.status === 'completed' && String(row.dialogue || '').trim()
    ? PRESENTATION_CHECKPOINT_FIELDS
    : ['processingMessageUpdatedAtIso'];
}

function planSideEffectGuard(rows, summaryRows, executionID, nowIso, stage) {
  if (!['transcript', 'analysis', 'message_update'].includes(stage)) throw new Error('Invalid presentation stage');
  const plan = planCanonicalReconciliation(rows, summaryRows);
  if (plan.action !== 'ready') return plan;
  const canonical = requireCanonicalOwner(rows, executionID, nowIso);
  if (selectNextStage(canonical) !== stage) throw new Error('Presentation stage changed');
  return { action: 'ready', canonical: { ...canonical, presentationStage: stage } };
}

function extractSlackUploadID(items) {
  const meaningful = (Array.isArray(items) ? items : []).filter((item) => (
    item?.json && typeof item.json === 'object' && Object.keys(item.json).length > 0
  ));
  if (meaningful.length !== 1) throw new Error('Expected exactly one Slack upload file item');
  const file = meaningful[0].json;
  if (file.ok === false || file.error || file.errors || !/^F[A-Z0-9]+$/.test(file.id || '')) {
    throw new Error('Slack upload item has no valid file ID');
  }
  return file.id;
}

function buildFinalText(row) {
  const title = row.status === 'completed' ? 'STT Done' : row.status === 'timed_out' ? 'STT Timed Out' : 'STT Failed';
  return `🤖 ${title}\nStream: \`${row.streamID}\`\nMode: \`${row.mode}\` ${row.durationMinutes}m`;
}

function planPresentationFailure(row, nowIso, errorCode) {
  const attempt = Number(row?.presentationAttempt);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3) throw new Error('Invalid current presentation attempt');
  strictIso(nowIso, 'current time');
  const terminal = attempt >= 3;
  const delay = attempt === 1 ? 60_000 : 5 * 60_000;
  return {
    presentationStatus: terminal ? 'failed' : 'retry_pending',
    presentationLeaseOwner: '',
    presentationLeaseUntilIso: '',
    presentationAttempt: attempt,
    presentationNextRetryAtIso: terminal ? '' : new Date(Date.parse(nowIso) + delay).toISOString(),
    presentationErrorCode: String(errorCode || 'presentation_stage_failed').slice(0, 80),
    updatedAtIso: nowIso,
  };
}

function checkpointCrashCode(stage, uploadSucceeded) {
  if (uploadSucceeded && ['transcript', 'analysis'].includes(stage)) return 'potential_duplicate_upload';
  return `presentation_${stage}_failed`;
}

function verifyFailureOwnerSnapshot(rows, claim, errorContext, executionID, nowIso) {
  const attemptRows = validateRows(rows);
  const canonicals = attemptRows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicals.length !== 1) throw new Error('Expected exactly one failure canonical');
  if (!claim || typeof claim !== 'object') throw new Error('Original presentation claim is unavailable');
  const row = canonicals[0];
  const immutableFields = ['id', 'attemptKey', 'attempt', 'dialogue', 'language', ...COMPLETION_PROVENANCE_FIELDS];
  for (const field of immutableFields) {
    if (row[field] !== claim[field]) throw new Error(`Failure claim provenance mismatch: ${field}`);
  }
  if (row.canonicalRowID !== String(row.id) || !['completed', 'failed', 'timed_out'].includes(row.status) || row.presentationStatus !== 'presenting') {
    throw new Error('Failure canonical is not presenting');
  }
  if (row.presentationLeaseOwner !== executionID || row.presentationLeaseOwner !== claim.presentationLeaseOwner) {
    throw new Error('Failure presentation owner mismatch');
  }
  if (row.presentationLeaseUntilIso !== claim.presentationLeaseUntilIso) throw new Error('Failure presentation lease changed');
  if (strictIso(row.presentationLeaseUntilIso, 'presentation lease') <= strictIso(nowIso, 'current time')) {
    throw new Error('Failure presentation lease expired');
  }
  const attempt = Number(row.presentationAttempt);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3 || attempt !== Number(claim.presentationAttempt)) {
    throw new Error('Failure presentation attempt mismatch');
  }
  const allowedContexts = {
    claim_owner: ['presentation_claim_owner_failed', false],
    side_effect_guard: ['presentation_side_effect_guard_failed', false],
    transcript: ['presentation_transcript_failed', false],
    transcript_checkpoint: ['potential_duplicate_upload', true],
    analysis: ['presentation_analysis_failed', false],
    analysis_checkpoint: ['potential_duplicate_upload', true],
    message_update: ['presentation_message_update_failed', false],
    complete: ['presentation_complete_failed', false],
  };
  const contextKeys = Object.keys(errorContext || {}).sort();
  if (contextKeys.join(',') !== 'errorCode,failureSource,potentialDuplicateUpload') {
    throw new Error('Invalid sanitized presentation error context fields');
  }
  const expected = allowedContexts[errorContext.failureSource];
  if (!expected || errorContext.errorCode !== expected[0] || errorContext.potentialDuplicateUpload !== expected[1]) {
    throw new Error('Invalid sanitized presentation error context');
  }
  return {
    ...row,
    failureSource: errorContext.failureSource,
    errorCode: errorContext.errorCode,
    potentialDuplicateUpload: errorContext.potentialDuplicateUpload,
  };
}

function verifyCheckpoint(rows, expected, checkpointField, checkpointValue) {
  const canonical = requireCanonicalOwner(rows, expected.presentationLeaseOwner, expected.nowIso);
  if (canonical.id !== expected.id || canonical.attemptKey !== expected.attemptKey) throw new Error('Checkpoint provenance mismatch');
  if (canonical[checkpointField] !== checkpointValue) throw new Error('Checkpoint write was not confirmed');
  return canonical;
}

function verifyExactCheckpoint(rows, expected) {
  const attemptRows = validateRows(rows);
  const canonicals = attemptRows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicals.length !== 1) throw new Error('Expected exactly one checkpoint canonical');
  const row = canonicals[0];
  if (row.canonicalRowID !== String(row.id) || row.status !== 'completed' || row.presentationStatus !== 'presenting') {
    throw new Error('Checkpoint canonical state mismatch');
  }
  for (const field of ['id', 'attemptKey', 'canonicalRowID', 'status', 'presentationStatus', 'presentationLeaseOwner', 'presentationLeaseUntilIso', 'presentationAttempt']) {
    if (row[field] !== expected[field]) throw new Error(`Checkpoint provenance mismatch: ${field}`);
  }
  if (!['transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso'].includes(expected.checkpointField)) {
    throw new Error('Invalid checkpoint field');
  }
  if (row[expected.checkpointField] !== expected.checkpointValue) throw new Error('Checkpoint value mismatch');
  return row;
}

function verifyFrozenConflict(rows, expectedIDs) {
  const attemptRows = validateRows(rows);
  const expected = new Set(expectedIDs);
  const canonicals = attemptRows.filter((row) => row.reconciliationStatus === 'canonical');
  if (expected.size === 0 || canonicals.length !== expected.size) throw new Error('Canonical conflict freeze is incomplete');
  for (const row of canonicals) {
    if (!expected.has(row.id) || row.canonicalRowID !== String(row.id)) throw new Error('Frozen canonical identity mismatch');
    if (row.status !== 'manual_review' || row.manualReviewReason !== 'multiple_canonical_checkpoint_conflict') throw new Error('Frozen canonical state mismatch');
    strictIso(row.manualReviewAtIso, 'manualReviewAtIso');
    if (row.presentationLeaseOwner !== '' || row.presentationLeaseUntilIso !== '') throw new Error('Frozen canonical presentation lease was not cleared');
  }
  return canonicals;
}

function buildCompletionExpectation(claim, checkpoint) {
  if (!claim || !checkpoint || claim.id !== checkpoint.id || claim.attemptKey !== checkpoint.attemptKey) {
    throw new Error('Completion snapshot identity mismatch');
  }
  const claimFields = ['id', 'attemptKey', 'attempt', 'presentationAttempt', ...COMPLETION_PROVENANCE_FIELDS];
  const expectedClaim = Object.fromEntries(claimFields.map((field) => [field, claim[field]]));
  const checkpointFields = presentationCheckpointFields(claim);
  const expectedCheckpoints = Object.fromEntries(checkpointFields.map((field) => [field, checkpoint[field]]));
  if (checkpointFields.some((field) => typeof expectedCheckpoints[field] !== 'string' || !expectedCheckpoints[field])) {
    throw new Error('Completion checkpoint is missing');
  }
  return { expectedClaim, expectedCheckpoints };
}

function verifyCompletion(rows, expectation) {
  const attemptRows = validateRows(rows);
  const canonicals = attemptRows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicals.length !== 1) throw new Error('Expected exactly one completion canonical');
  const row = canonicals[0];
  if (row.canonicalRowID !== String(row.id) || !['completed', 'failed', 'timed_out'].includes(row.status) || row.presentationStatus !== 'completed') {
    throw new Error('Presentation completion state mismatch');
  }
  if (row.presentationLeaseOwner !== '' || row.presentationLeaseUntilIso !== '') throw new Error('Presentation completion lease was not cleared');
  for (const [field, value] of Object.entries(expectation.expectedClaim || {})) {
    if (row[field] !== value) throw new Error(`Completion claim mismatch: ${field}`);
  }
  for (const [field, value] of Object.entries(expectation.expectedCheckpoints || {})) {
    if (!presentationCheckpointFields(row).includes(field) || row[field] !== value) throw new Error(`Completion checkpoint mismatch: ${field}`);
  }
  if (Object.keys(expectation.expectedCheckpoints || {}).length !== presentationCheckpointFields(row).length) {
    throw new Error('Completion checkpoints are incomplete');
  }
  return row;
}

function verifyTerminalPresentation(rows, expected) {
  const attemptRows = validateRows(rows);
  const canonical = attemptRows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonical.length !== 1 || canonical[0].id !== expected.id) throw new Error('Presentation final canonical mismatch');
  const row = canonical[0];
  for (const field of ['presentationStatus', 'presentationAttempt', 'presentationNextRetryAtIso', 'presentationErrorCode']) {
    if (row[field] !== expected[field]) throw new Error(`Presentation final field mismatch: ${field}`);
  }
  if (row.presentationLeaseOwner !== '' || row.presentationLeaseUntilIso !== '') throw new Error('Presentation lease was not cleared');
  return row;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ATTEMPT_CHECKPOINT_FIELDS,
    CLEAN_RECONCILIATION_MUTATION_FIELDS,
    COMPLETION_PROVENANCE_FIELDS,
    FREEZE_MUTATION_FIELDS,
    PRESENTATION_CHECKPOINT_FIELDS,
    PRESENTATION_MUTATION_FIELDS,
    SUMMARY_CHECKPOINT_FIELDS,
    buildFinalText,
    buildCompletionExpectation,
    checkpointCrashCode,
    extractSlackUploadID,
    planCanonicalReconciliation,
    planPresentationFailure,
    planSideEffectGuard,
    presentationLeaseExpiry,
    presentationCheckpointFields,
    requireCanonicalOwner,
    requireEligibleCanonical,
    selectNextStage,
    validateAttemptKey,
    verifyCheckpoint,
    verifyCompletion,
    verifyExactCheckpoint,
    verifyFrozenConflict,
    verifyFailureOwnerSnapshot,
    verifyTerminalPresentation,
  };
}

if (typeof $input !== 'undefined') {
  const input = $input.first().json;
  const mode = input.presentationHelperMode;
  if (mode === 'validate_input') {
    return [{ json: { attemptKey: validateAttemptKey(input.attemptKey) } }];
  }
  if (mode === 'require_eligible') return [{ json: requireEligibleCanonical(input.rows) }];
  if (mode === 'next_stage') return [{ json: { presentationStage: selectNextStage(input.row) } }];
  if (mode === 'final_text') return [{ json: { text: buildFinalText(input.row) } }];
  throw new Error('Presentation helper mode is required');
}
