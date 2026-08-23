const CHANNEL = 'C0A4JJJKJMD';
const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d{6}$/;
const CANONICAL_MODES = new Set(['fromStart', 'fromEnd']);
const ATTEMPT_FIELDS = Object.freeze([
  'attemptKey', 'logicalJobKey', 'requestKey', 'requestType', 'attempt', 'role',
  'streamID', 'mode', 'durationMinutes', 'streamContextJson', 'status',
  'callbackTokenHash', 'reconciliationStatus', 'canonicalRowID', 'dispatchLeaseOwner',
  'dispatchLeaseUntilIso', 'submittedAtIso', 'callbackDeadlineAtIso',
  'manualReviewReason', 'manualReviewAtIso', 'manualReviewResolution',
  'callbackTokenExpiresAtIso', 'consumedAtIso', 'channel', 'threadTS',
  'processingMessageTS', 'dialogue', 'language', 'errorCode', 'nextRetryAtIso',
  'retryLeaseOwner', 'retryLeaseUntilIso', 'duplicateCount', 'presentationStatus',
  'presentationLeaseOwner', 'presentationLeaseUntilIso', 'presentationAttempt',
  'presentationNextRetryAtIso', 'presentationErrorCode', 'transcriptUploadID',
  'analysisUploadID', 'processingMessageUpdatedAtIso', 'createdAtIso', 'updatedAtIso',
]);

function requiredString(value, fieldName) {
  if (typeof value !== 'string' || value === '') throw new Error(`${fieldName} must be a non-empty string`);
  return value;
}

function processingMessageTimestamp(slack) {
  const value = slack?.message?.ts ?? slack?.ts;
  if (typeof value !== 'string' || !SLACK_TIMESTAMP_PATTERN.test(value)) {
    throw new Error('Slack processing message timestamp is invalid');
  }
  return value;
}

function buildAttempt(input, streamContext, slack, nowIso = new Date().toISOString()) {
  const streamID = requiredString(input?.streamID, 'streamID');
  const threadTS = requiredString(input?.target_thread_ts, 'target_thread_ts');
  const mode = requiredString(input?.mode, 'mode');
  if (!CANONICAL_MODES.has(mode)) throw new Error('mode must be canonical');
  if (input.channel !== CHANNEL) throw new Error('Invalid channel');
  if (typeof input.mins !== 'number' || !Number.isFinite(input.mins) || input.mins <= 0) {
    throw new Error('mins must be a positive finite number');
  }
  if (!streamContext || typeof streamContext !== 'object' || Array.isArray(streamContext)
    || streamContext.liveStreamID !== streamID || streamContext.eligible !== true
    || streamContext.profile !== 'stt') {
    throw new Error('Invalid resolver-owned stream context');
  }
  const parsedNow = Date.parse(nowIso);
  if (typeof nowIso !== 'string' || !Number.isFinite(parsedNow)) throw new Error('nowIso must be valid');
  const logicalJobKey = `stt:${threadTS}:${streamID}:${mode}`;
  const attempt = {
    attemptKey: `${logicalJobKey}:1`, logicalJobKey, requestKey: logicalJobKey,
    requestType: 'standalone_stt', attempt: 1, role: 'summary_item', streamID, mode,
    durationMinutes: input.mins, streamContextJson: JSON.stringify(streamContext),
    status: 'queued', callbackTokenHash: '', reconciliationStatus: 'pending', canonicalRowID: '',
    dispatchLeaseOwner: '', dispatchLeaseUntilIso: '', submittedAtIso: '', callbackDeadlineAtIso: '',
    manualReviewReason: '', manualReviewAtIso: '', manualReviewResolution: '',
    callbackTokenExpiresAtIso: '', consumedAtIso: '', channel: CHANNEL, threadTS,
    processingMessageTS: processingMessageTimestamp(slack), dialogue: '', language: '', errorCode: '',
    nextRetryAtIso: '', retryLeaseOwner: '', retryLeaseUntilIso: '', duplicateCount: 0,
    presentationStatus: 'pending', presentationLeaseOwner: '', presentationLeaseUntilIso: '',
    presentationAttempt: 0, presentationNextRetryAtIso: '', presentationErrorCode: '',
    transcriptUploadID: '', analysisUploadID: '', processingMessageUpdatedAtIso: '',
    createdAtIso: nowIso, updatedAtIso: nowIso,
  };
  if (Object.keys(attempt).length !== ATTEMPT_FIELDS.length
    || ATTEMPT_FIELDS.some((field, index) => Object.keys(attempt)[index] !== field)) {
    throw new Error('Attempt schema drift');
  }
  return attempt;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ATTEMPT_FIELDS, buildAttempt, processingMessageTimestamp };
}

if (typeof $input !== 'undefined') {
  const input = $('Normalize Standalone Input').first().json;
  const streamContext = $('Require Eligible Stream Context').first().json;
  return [{ json: buildAttempt(input, streamContext, $input.first().json) }];
}
