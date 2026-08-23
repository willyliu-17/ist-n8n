const CONTRACT = Object.freeze({
  modes: Object.freeze(['fromStart', 'fromEnd']),
  identities: Object.freeze(['requestKey', 'logicalJobKey', 'attemptKey']),
  channel: 'channel',
  adapterAliases: Object.freeze({
    modes: Object.freeze({ first: 'fromStart', last: 'fromEnd' }),
    identities: Object.freeze({ candidateKey: 'requestKey', jobKey: 'logicalJobKey' }),
    channels: Object.freeze({ channelID: 'channel', channelId: 'channel' }),
  }),
  attemptStatuses: Object.freeze([
    'queued',
    'dispatching',
    'waiting_callback',
    'completed',
    'retry_pending',
    'retry_materializing',
    'retry_materialized',
    'failed',
    'timed_out',
    'manual_review',
  ]),
  requestStatuses: Object.freeze([
    'creating',
    'ready',
    'waiting_stt',
    'summary_dispatching',
    'summary_retry_pending',
    'manual_review',
    'completed',
    'failed',
    'creation_failed',
  ]),
  reconciliationStatuses: Object.freeze(['pending', 'canonical', 'duplicate']),
  manualReviewOriginalStages: Object.freeze([
    'ready',
    'summary_dispatching',
    'summary_retry_pending',
    'completed',
  ]),
});

const orderedStreams = Object.freeze([
  Object.freeze({
    role: 'current',
    liveStreamID: '9001',
    mode: 'fromStart',
    durationMinutes: 5,
    streamContext: Object.freeze({
      liveStreamID: '9001',
      eligible: true,
      beginTime: 1787360400,
      endTime: 1787364000,
    }),
  }),
]);

const CHECKPOINT_FIELDS = Object.freeze([
  'submittedAtIso',
  'callbackDeadlineAtIso',
  'consumedAtIso',
  'dialogue',
  'transcriptUploadID',
  'analysisUploadID',
  'processingMessageUpdatedAtIso',
  'inferenceResultJson',
  'summaryMarkdown',
  'summaryUploadID',
  'summaryMessageTS',
]);

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

function resolveCanonicalConflict(rows) {
  const canonicalRows = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  if (canonicalRows.length < 2) {
    return { action: 'none', canonical: canonicalRows[0] || null, demoteRowIDs: [] };
  }
  if (rows.some(hasCheckpoint)) {
    return { action: 'manual_review', reason: 'multiple_canonical_checkpoint_conflict' };
  }

  const [canonical, ...duplicates] = [...canonicalRows].sort(compareRows);
  return {
    action: 'reconcile',
    canonical,
    demoteRowIDs: duplicates.map(({ id }) => id),
  };
}

function reconcileRows(rows) {
  if (rows.length === 0) {
    return { canonical: null, duplicates: [] };
  }

  const existingCanonicals = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  let conflict;
  if (existingCanonicals.length > 1) {
    conflict = resolveCanonicalConflict(rows);
    if (conflict.action === 'manual_review') {
      return { canonical: null, duplicates: [], conflict };
    }
  }

  const canonicalSource = existingCanonicals.length === 1
    ? existingCanonicals[0]
    : conflict?.canonical || [...rows].sort(compareRows)[0];
  const canonical = {
    ...canonicalSource,
    reconciliationStatus: 'canonical',
    canonicalRowID: canonicalSource.id,
  };
  const duplicates = rows
    .filter(({ id }) => id !== canonical.id)
    .map((row) => ({
      ...row,
      reconciliationStatus: 'duplicate',
      canonicalRowID: canonical.id,
    }));

  return { canonical, duplicates };
}

module.exports = {
  CONTRACT,
  orderedStreams,
  reconcileRows,
  resolveCanonicalConflict,
};
