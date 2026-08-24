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

function buildAttempts(normalized, nowIso = new Date().toISOString()) {
  if (!normalized || !Array.isArray(normalized.orderedStreams) || !Array.isArray(normalized.expectedLogicalJobKeys)) {
    throw new Error('Invalid normalized request');
  }
  const expected = new Set(normalized.expectedLogicalJobKeys);
  return normalized.orderedStreams
    .map((stream) => {
      const logicalJobKey = `${normalized.requestKey}:${stream.role}:${stream.liveStreamID}:${stream.mode}`;
      if (!expected.has(logicalJobKey)) return null;
      const attempt = {
        attemptKey: `${logicalJobKey}:1`, logicalJobKey, requestKey: normalized.requestKey,
        requestType: normalized.requestType, attempt: 1, role: stream.role,
        streamID: stream.liveStreamID, mode: stream.mode, durationMinutes: stream.durationMinutes,
        streamContextJson: JSON.stringify(stream.streamContext), status: 'queued', callbackTokenHash: '',
        reconciliationStatus: 'pending', canonicalRowID: '', dispatchLeaseOwner: '',
        dispatchLeaseUntilIso: '', submittedAtIso: '', callbackDeadlineAtIso: '',
        manualReviewReason: '', manualReviewAtIso: '', manualReviewResolution: '',
        callbackTokenExpiresAtIso: '', consumedAtIso: '', channel: normalized.channel,
        threadTS: normalized.threadTS, processingMessageTS: stream.processingMessageTS,
        dialogue: '', language: '', errorCode: '', nextRetryAtIso: '', retryLeaseOwner: '',
        retryLeaseUntilIso: '', duplicateCount: 0, presentationStatus: 'pending',
        presentationLeaseOwner: '', presentationLeaseUntilIso: '', presentationAttempt: 0,
        presentationNextRetryAtIso: '', presentationErrorCode: '', transcriptUploadID: '',
        analysisUploadID: '', processingMessageUpdatedAtIso: '', createdAtIso: nowIso, updatedAtIso: nowIso,
      };
      if (Object.keys(attempt).length !== ATTEMPT_FIELDS.length
        || ATTEMPT_FIELDS.some((field, index) => Object.keys(attempt)[index] !== field)) throw new Error('Attempt schema drift');
      return attempt;
    })
    .filter(Boolean);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { ATTEMPT_FIELDS, buildAttempts };

if (typeof $input !== 'undefined') {
  const attempts = buildAttempts($('Normalize Request').first().json);
  return attempts.length ? attempts.map((json) => ({ json })) : [{ json: { noMissingAttempts: true } }];
}
