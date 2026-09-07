const PROVENANCE_FIELDS = Object.freeze([
  'attemptKey',
  'logicalJobKey',
  'requestKey',
  'requestType',
  'streamID',
  'mode',
  'channel',
  'threadTS',
  'processingMessageTS',
]);
const LOGICAL_PROVENANCE_FIELDS = Object.freeze([
  'logicalJobKey',
  'requestKey',
  'requestType',
  'role',
  'streamID',
  'mode',
  'channel',
  'threadTS',
  'processingMessageTS',
]);
const ALLOWED_UNCONSUMED_STATUSES = new Set(['waiting_callback', 'retry_pending', 'manual_review']);
const RECONCILIATION_STATUSES = new Set(['pending', 'canonical', 'duplicate']);
const MAX_AUTOMATIC_ATTEMPTS = 20;
const SUMMARY_MAX_AUTOMATIC_ATTEMPTS = 6;

function isSingleStreamSummary(requestType) {
  return requestType === 'single_stream_summary';
}

function systemRowID(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  return typeof value === 'string' && value !== '';
}

function parseIso(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`Invalid ${field}`);
  }
  return timestamp;
}

function response(action, responseClass, httpStatus, canonical, reason) {
  return {
    action,
    responseClass,
    httpStatus,
    attemptKey: canonical.attemptKey,
    requestKey: canonical.requestKey,
    logicalJobKey: canonical.logicalJobKey,
    reason,
  };
}

function requireCanonical(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Attempt row not found');
  const attemptKey = rows[0].attemptKey;
  if (typeof attemptKey !== 'string' || !attemptKey) throw new Error('Invalid attempt key');
  for (const row of rows) {
    if (row.attemptKey !== attemptKey) throw new Error('Invalid same-attempt row set');
  }
  const canonicalRows = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  if (canonicalRows.length !== 1) throw new Error('Expected exactly one canonical attempt');
  const canonical = canonicalRows[0];
  if (canonical.canonicalRowID !== String(canonical.id)) throw new Error('Canonical row does not point to itself');
  return canonical;
}

function validateLogicalRows(rows, expected) {
  if (!Array.isArray(rows)) throw new Error('Invalid logical job row set');
  if (LOGICAL_PROVENANCE_FIELDS.some((field) => typeof expected[field] !== 'string' || expected[field] === '')) {
    throw new Error('Invalid immutable logical provenance');
  }
  const meaningfulRows = rows.filter((row) => row && Object.keys(row).length > 0);
  if (meaningfulRows.length === 0) throw new Error('Logical job rows not found');

  const ids = new Set();
  const attempts = new Map();
  for (const row of meaningfulRows) {
    if (
      !systemRowID(row.id) || ids.has(row.id) ||
      typeof row.attemptKey !== 'string' || row.attemptKey === '' ||
      !RECONCILIATION_STATUSES.has(row.reconciliationStatus)
    ) {
      throw new Error('Invalid logical job row integrity');
    }
    if (LOGICAL_PROVENANCE_FIELDS.some((field) => row[field] !== expected[field])) {
      throw new Error('Immutable logical provenance mismatch');
    }
    ids.add(row.id);
    if (!attempts.has(row.attemptKey)) attempts.set(row.attemptKey, []);
    attempts.get(row.attemptKey).push(row);
  }

  const canonicalRows = [];
  for (const attemptRows of attempts.values()) {
    const canonicals = attemptRows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
    if (canonicals.length !== 1 || canonicals[0].canonicalRowID !== String(canonicals[0].id)) {
      throw new Error('Logical attempt requires exactly one self-owned canonical row');
    }
    const canonical = canonicals[0];
    canonicalRows.push(canonical);
    for (const row of attemptRows) {
      if (
        (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') ||
        (row.reconciliationStatus === 'duplicate' && row.canonicalRowID !== String(canonical.id))
      ) {
        throw new Error('Invalid logical attempt canonical linkage');
      }
    }
  }
  return canonicalRows;
}

function resultPatch(canonical, normalized, hash, nowIso, desiredStatus, errorCode, nextRetryAtIso) {
  return {
    action: 'claim',
    responseClass: 'accepted',
    httpStatus: 202,
    id: canonical.id,
    callbackTokenHash: hash,
    attemptKey: canonical.attemptKey,
    logicalJobKey: canonical.logicalJobKey,
    requestKey: canonical.requestKey,
    requestType: canonical.requestType,
    role: canonical.role,
    streamID: canonical.streamID,
    mode: canonical.mode,
    channel: canonical.channel,
    threadTS: canonical.threadTS,
    processingMessageTS: canonical.processingMessageTS,
    expectedStatus: canonical.status,
    expectedManualReviewResolution: canonical.status === 'manual_review' ? '' : undefined,
    consumedAtIso: nowIso,
    desiredStatus,
    dialogue: desiredStatus === 'completed' ? normalized.transcription : '',
    language: desiredStatus === 'completed' && normalized.transcription !== '' ? normalized.language : '',
    errorCode,
    nextRetryAtIso,
    desiredPresentationStatus: desiredStatus === 'completed' && normalized.transcription === ''
      ? 'completed'
      : canonical.presentationStatus,
  };
}

function failurePatch(canonical, normalized, hash, nowIso, errorCode, terminalStatus = 'failed') {
  // A submitted full-stream conversion must never create another SegmentTask from its callback.
  if (isSingleStreamSummary(canonical.requestType)) {
    return resultPatch(canonical, normalized, hash, nowIso, terminalStatus, errorCode, '');
  }
  const maximumAttempts = canonical.requestType === 'standalone_stt'
    ? MAX_AUTOMATIC_ATTEMPTS
    : SUMMARY_MAX_AUTOMATIC_ATTEMPTS;
  if (canonical.attempt < maximumAttempts) {
    return resultPatch(
      canonical,
      normalized,
      hash,
      nowIso,
      'retry_pending',
      errorCode,
      canonical.callbackDeadlineAtIso,
    );
  }
  return resultPatch(canonical, normalized, hash, nowIso, terminalStatus, errorCode, '');
}

function classifyClaim(attemptRows, normalized, hash, nowIso, logicalJobRows) {
  const canonical = requireCanonical(attemptRows);
  if (!normalized?.valid || !normalized.context) throw new Error('Invalid normalized callback');
  if (!/^[0-9a-f]{64}$/.test(hash) || canonical.callbackTokenHash !== hash) {
    return response('reject', 'invalid_token', 401, canonical, 'invalid_token');
  }
  if (PROVENANCE_FIELDS.some((field) => canonical[field] !== normalized.context[field])) {
    return response('reject', 'rejected', 400, canonical, 'provenance_mismatch');
  }
  const now = parseIso(nowIso, 'current time');
  const expiresAt = parseIso(canonical.callbackTokenExpiresAtIso, 'token expiry');
  if (expiresAt <= now) return response('reject', 'rejected', 400, canonical, 'expired_token');

  const logicalCanonicals = validateLogicalRows(
    logicalJobRows === undefined ? attemptRows : logicalJobRows,
    canonical,
  );

  if (canonical.consumedAtIso !== '') {
    parseIso(canonical.consumedAtIso, 'consumed time');
    return response('duplicate', 'duplicate', 200, canonical, 'already_consumed');
  }

  const completedElsewhere = logicalCanonicals.some((row) => (
    row.attemptKey !== canonical.attemptKey && row.status === 'completed'
  ));
  if (completedElsewhere) {
    return response('duplicate', 'duplicate', 200, canonical, 'logical_job_already_completed');
  }

  if (!ALLOWED_UNCONSUMED_STATUSES.has(canonical.status)) {
    return response('reject', 'conflict', 409, canonical, 'status_not_claimable');
  }
  if (canonical.status === 'manual_review' && canonical.manualReviewResolution !== '') {
    return response('reject', 'conflict', 409, canonical, 'manual_review_resolved');
  }
  if (!Number.isInteger(canonical.attempt) || canonical.attempt < 1) {
    throw new Error('Invalid attempt number');
  }

  if (canonical.status === 'manual_review') {
    if (!normalized.retryableServiceError && normalized.statusCode >= 200 && normalized.statusCode < 300) {
      const errorCode = normalized.transcription === '' ? 'callback_empty_transcription' : '';
      return resultPatch(canonical, normalized, hash, nowIso, 'completed', errorCode, '');
    }
    if (canonical.callbackDeadlineAtIso !== '') {
      const deadline = parseIso(canonical.callbackDeadlineAtIso, 'callback deadline');
      if (deadline <= now) {
        return resultPatch(canonical, normalized, hash, nowIso, 'failed', 'callback_deadline_expired', '');
      }
    }
    if (normalized.retryableServiceError) {
      return resultPatch(
        canonical,
        normalized,
        hash,
        nowIso,
        'failed',
        `callback_service_${normalized.statusCode}`,
        '',
      );
    }
    return resultPatch(canonical, normalized, hash, nowIso, 'failed', `callback_service_${normalized.statusCode}`, '');
  }

  if (isSingleStreamSummary(canonical.requestType)) {
    if (canonical.callbackDeadlineAtIso === '') throw new Error('Invalid callback deadline');
    const deadline = parseIso(canonical.callbackDeadlineAtIso, 'callback deadline');
    if (deadline <= now) {
      return failurePatch(canonical, normalized, hash, nowIso, 'callback_deadline_expired', 'timed_out');
    }
  }

  if (!normalized.retryableServiceError && normalized.statusCode >= 200 && normalized.statusCode < 300) {
    const errorCode = normalized.transcription === '' ? 'callback_empty_transcription' : '';
    return resultPatch(canonical, normalized, hash, nowIso, 'completed', errorCode, '');
  }
  if (canonical.callbackDeadlineAtIso !== '') {
    const deadline = parseIso(canonical.callbackDeadlineAtIso, 'callback deadline');
    if (deadline <= now) {
      return failurePatch(canonical, normalized, hash, nowIso, 'callback_deadline_expired', 'timed_out');
    }
  } else {
    throw new Error('Invalid callback deadline');
  }
  if (normalized.retryableServiceError) {
    return failurePatch(canonical, normalized, hash, nowIso, `callback_service_${normalized.statusCode}`);
  }
  return resultPatch(
    canonical,
    normalized,
    hash,
    nowIso,
    'failed',
    `callback_service_${normalized.statusCode}`,
    '',
  );
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MAX_AUTOMATIC_ATTEMPTS, classifyClaim };
}

if (typeof $input !== 'undefined') {
  const attemptRows = $('Re-read After Reconciliation').isExecuted
    ? $('Re-read After Reconciliation').all().map(({ json }) => json)
    : $('Read All Attempt Rows').all().map(({ json }) => json);
  const result = classifyClaim(
    attemptRows,
    $('Normalize Callback').first().json,
    $('Hash Callback Token').first().json.callbackTokenHash,
    new Date().toISOString(),
    $input.all().map(({ json }) => json),
  );
  return [{ json: result }];
}
