const SCHEMA_KEYS = Object.freeze([
  'errorKey', 'component', 'reconciliationStatus', 'canonicalRowID', 'requestKey',
  'logicalJobKey', 'attemptKey', 'executionID', 'workflowName', 'nodeName',
  'errorCode', 'messageMasked', 'retryable', 'createdAtIso',
]);

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

const REQUEST_FIELDS = Object.freeze([
  'requestKey', 'requestType', 'status', 'creationLeaseOwner', 'reconciliationStatus',
  'canonicalRowID', 'creationLeaseUntilIso', 'orderedStreamsJson', 'existingDialoguesJson',
  'expectedLogicalJobKeysJson', 'channel', 'threadTS', 'coverageStatus',
  'availableRolesJson', 'missingRolesJson', 'failedLogicalJobKeysJson', 'leaseOwner',
  'leaseUntilIso', 'summaryAttempt', 'nextRetryAtIso', 'errorCode', 'inferenceResultJson',
  'summaryMarkdown', 'summaryMessageTS', 'summaryUploadID', 'manualReviewReason',
  'manualReviewAtIso', 'manualReviewResolution', 'manualReviewOriginalStage',
  'manualResolutionWinnerRowID', 'manualResolutionDecisionID', 'createdAtIso', 'updatedAtIso',
]);

const ATTEMPT_IMMUTABLE_FIELDS = Object.freeze([
  'attemptKey', 'logicalJobKey', 'requestKey', 'requestType', 'attempt', 'role',
  'streamID', 'mode', 'durationMinutes', 'streamContextJson', 'channel', 'threadTS',
  'processingMessageTS',
]);

const REQUEST_IMMUTABLE_FIELDS = Object.freeze([
  'requestKey', 'requestType', 'orderedStreamsJson', 'existingDialoguesJson',
  'expectedLogicalJobKeysJson', 'channel', 'threadTS',
]);

const ATTEMPT_CHECKPOINT_FIELDS = Object.freeze([
  'submittedAtIso', 'callbackDeadlineAtIso', 'consumedAtIso', 'dialogue',
  'transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso',
]);

const SUMMARY_CHECKPOINT_FIELDS = Object.freeze([
  'inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS',
]);

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_AUTOMATIC_ATTEMPTS = 20;
const STT_RETRY_SLOT_MINUTES = Object.freeze([1, 2, 4, 6, 9, 13, 18, 25, 35, 48, 65, 88, 118, 158, 211, 281, 374, 497, 660]);
const STT_RETRY_DEADLINE_MINUTES = 720;
const SUMMARY_STT_RETRY_SLOT_MINUTES = Object.freeze([1, 2, 4, 6, 9, 13, 18, 25]);
const SUMMARY_STT_RETRY_DEADLINE_MINUTES = 30;
const RECONCILIATION_STATUSES = new Set(['pending', 'canonical', 'duplicate']);
const REQUEST_STAGES = new Set(['ready', 'summary_dispatching', 'summary_retry_pending', 'completed']);
const REQUEST_STATUSES = new Set(['creating', 'ready', 'waiting_stt', 'summary_dispatching', 'summary_retry_pending', 'manual_review', 'completed', 'failed', 'creation_failed']);
const PENDING_ATTEMPT_STATUSES = new Set(['queued', 'dispatching', 'waiting_callback', 'retry_pending', 'retry_materializing']);
const TERMINAL_ATTEMPT_STATUSES = new Set(['failed', 'timed_out']);
const REPAIR_CLASS_ORDER = Object.freeze([
  'expired_dispatch_lease',
  'callback_deadline',
  'retry_materialization',
  'creation_lease',
  'summary_lease',
  'presentation_lease',
  'duplicate_deterministic_keys',
]);
const REPAIR_CLASS_CAP = 50;
const CHANNEL = 'C0A4JJJKJMD';
const ALLOWED_CHANNELS = new Set([CHANNEL, 'C09F0SYG57D']);
const RESOLUTION_EPOCH_ISO = '1970-01-01T00:00:00.000Z';

function nonempty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function strictIso(value, name) {
  if (!nonempty(value) || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error(`Invalid ${name}`);
  }
  return Date.parse(value);
}

function addMinutes(iso, minutes) {
  return new Date(strictIso(iso, 'current time') + minutes * 60_000).toISOString();
}

function nextRetryDelayMs(attemptNumber) {
  const attempt = Number(attemptNumber);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Invalid attempt number');
  if (attempt === 1) return 60_000;
  if (attempt === 2) return 300_000;
  throw new Error('Attempt retry is terminal');
}

function sttRetryPolicy(requestType) {
  return requestType === 'standalone_stt'
    ? { slots: STT_RETRY_SLOT_MINUTES, deadlineMinutes: STT_RETRY_DEADLINE_MINUTES }
    : { slots: SUMMARY_STT_RETRY_SLOT_MINUTES, deadlineMinutes: SUMMARY_STT_RETRY_DEADLINE_MINUTES };
}

function sttRetryTiming(requestCreatedAtIso, attemptNumber, requestType = 'standalone_stt') {
  const attempt = Number(attemptNumber);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Invalid attempt number');
  const policy = sttRetryPolicy(requestType);
  const deadlineAtIso = addMinutes(requestCreatedAtIso, policy.deadlineMinutes);
  return {
    deadlineAtIso,
    nextRetryAtIso: attempt <= policy.slots.length
      ? addMinutes(requestCreatedAtIso, policy.slots[attempt - 1])
      : '',
  };
}

function sttRetryDelayMs(attemptNumber) {
  const attempt = Number(attemptNumber);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt >= MAX_AUTOMATIC_ATTEMPTS) throw new Error('Attempt retry is terminal');
  const previous = attempt === 1 ? 0 : STT_RETRY_SLOT_MINUTES[attempt - 2];
  return (STT_RETRY_SLOT_MINUTES[attempt - 1] - previous) * 60_000;
}

function canonicalRequest(rows, requestKey) {
  const meaningful = meaningfulRows(rows);
  validateRequestRows(meaningful, requestKey);
  const canonical = meaningful.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
  if (canonical.length !== 1) throw new Error('Expected exactly one canonical request');
  return canonical[0];
}

function compareRows(left, right) {
  strictIso(left.createdAt, 'createdAt');
  strictIso(right.createdAt, 'createdAt');
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}

function hasCheckpoint(row, fields) {
  return fields.some((field) => row[field] !== undefined && row[field] !== null && row[field] !== '');
}

function meaningfulRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row && Object.keys(row).length > 0);
}

function validatePrimitive(value, field) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid primitive ${field}`);
    return value;
  }
  if (typeof value === 'boolean') return value;
  throw new Error(`Invalid primitive ${field}`);
}

function requireAllFields(row, fields, kind) {
  for (const field of fields) {
    if (!(field in row)) throw new Error(`${kind} missing field ${field}`);
    validatePrimitive(row[field], `${kind}.${field}`);
  }
}

function validateSystemFields(row, kind) {
  if (!Number.isInteger(row.id) || row.id <= 0) throw new Error(`Invalid ${kind} system field id`);
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof row[field] !== 'string' || row[field] === '') throw new Error(`Invalid ${kind} system field ${field}`);
  }
  strictIso(row.createdAt, `${kind}.createdAt`);
  strictIso(row.updatedAt, `${kind}.updatedAt`);
}

function validateReconciliation(row, kind) {
  if (!RECONCILIATION_STATUSES.has(row.reconciliationStatus)) throw new Error(`Invalid ${kind} reconciliation status`);
  if (typeof row.canonicalRowID !== 'string') throw new Error(`Invalid ${kind} canonical link`);
  if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== String(row.id)) throw new Error(`Canonical ${kind} self-link mismatch`);
  if (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') throw new Error(`Pending ${kind} must have empty canonical link`);
  if (row.reconciliationStatus === 'duplicate' && (row.canonicalRowID === '' || row.canonicalRowID === undefined)) {
    throw new Error(`Duplicate ${kind} must link to canonical`);
  }
}

function validateAttemptRow(row) {
  requireAllFields(row, ATTEMPT_FIELDS, 'attempt');
  validateSystemFields(row, 'attempt');
  validateReconciliation(row, 'attempt');
  const attemptNumber = Number(row.attempt);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) throw new Error('Invalid attempt number');
  for (const field of ['attemptKey', 'logicalJobKey', 'requestKey', 'requestType', 'role', 'streamID', 'mode', 'channel', 'threadTS', 'processingMessageTS']) {
    if (!nonempty(row[field])) throw new Error(`Invalid attempt ${field}`);
  }
  if (row.attemptKey !== `${row.logicalJobKey}:${attemptNumber}`) throw new Error('Invalid attempt identity');
  if (!['fromStart', 'fromEnd'].includes(row.mode)) throw new Error('Invalid attempt mode');
  if (!ALLOWED_CHANNELS.has(row.channel)) throw new Error('Invalid attempt channel');
  if (typeof row.durationMinutes !== 'number' || !Number.isFinite(row.durationMinutes) || row.durationMinutes <= 0) throw new Error('Invalid attempt duration');
  let context;
  try {
    context = JSON.parse(row.streamContextJson);
  } catch {
    throw new Error('Invalid attempt stream context JSON');
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('Invalid attempt stream context JSON');
  return row;
}

function validateRequestRow(row) {
  requireAllFields(row, REQUEST_FIELDS, 'request');
  validateSystemFields(row, 'request');
  validateReconciliation(row, 'request');
  if (!nonempty(row.requestKey) || !nonempty(row.requestType)) throw new Error('Invalid request identity');
  if (!REQUEST_STATUSES.has(row.status)) throw new Error('Invalid request status');
  if (Object.hasOwn(row, 'attemptKey') || Object.hasOwn(row, 'logicalJobKey')) {
    throw new Error('Request resolution rows must not carry attempt identity');
  }
  return row;
}

function immutableAttemptMatches(row, expected) {
  for (const field of ATTEMPT_IMMUTABLE_FIELDS) {
    if (row[field] !== expected[field]) throw new Error(`Immutable attempt payload conflict: ${field}`);
  }
}

function validateRequestRows(rows, requestKey) {
  if (!nonempty(requestKey) || !Array.isArray(rows) || rows.length === 0) throw new Error('Request rows not found');
  let baseline;
  for (const row of rows) {
    validateRequestRow(row);
    if (row.requestKey !== requestKey) throw new Error('Request key mismatch');
    const immutable = REQUEST_IMMUTABLE_FIELDS.map((field) => row[field]).join('\u0000');
    if (baseline !== undefined && baseline !== immutable) throw new Error('Request immutable replay mismatch');
    baseline = immutable;
  }
}

function maskText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function callbackFailure(errorCode, attemptNumber, nowIso, deadline, requestCreatedAtIso, requestType) {
  const attempt = Number(attemptNumber);
  const timing = sttRetryTiming(requestCreatedAtIso, attempt, requestType);
  const maximumAttempts = sttRetryPolicy(requestType).slots.length + 1;
  if (attempt >= maximumAttempts || strictIso(nowIso, 'current time') >= strictIso(timing.deadlineAtIso, 'retry deadline')) {
    return {
      classification: deadline ? 'callback_deadline_exhausted' : 'callback_retry_exhausted',
      status: deadline ? 'timed_out' : 'failed',
      errorCode,
      nextRetryAtIso: '',
    };
  }
  return {
    classification: deadline ? 'callback_deadline' : 'retryable_callback_failure',
    status: 'retry_pending',
    errorCode,
    nextRetryAtIso: timing.nextRetryAtIso,
  };
}

function classifyAttemptFailure(outcome, attemptNumber, nowIso = new Date().toISOString(), requestCreatedAtIso = nowIso, requestType = 'standalone_stt') {
  const attempt = Number(attemptNumber);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Invalid attempt number');
  strictIso(nowIso, 'current time');
  if (outcome?.transportError === true || outcome?.outcomeUncertain === true) {
    return {
      classification: 'ambiguous_transport',
      status: 'manual_review',
      manualReviewReason: 'vds_submit_outcome_ambiguous',
      manualReviewAtIso: nowIso,
      nextRetryAtIso: '',
      errorCode: '',
    };
  }
  if (outcome?.deadlineExceeded === true) return callbackFailure('callback_deadline_exceeded', attempt, nowIso, true, requestCreatedAtIso, requestType);
  if (outcome?.callbackEmpty === true) return callbackFailure('callback_empty_transcription', attempt, nowIso, false, requestCreatedAtIso, requestType);
  if (outcome?.retryableServiceError === true) return callbackFailure('callback_retryable_service_error', attempt, nowIso, false, requestCreatedAtIso, requestType);
  const statusCode = Number(outcome?.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return {
      classification: 'ambiguous_transport',
      status: 'manual_review',
      manualReviewReason: 'vds_submit_outcome_ambiguous',
      manualReviewAtIso: nowIso,
      nextRetryAtIso: '',
      errorCode: '',
    };
  }
  if (statusCode >= 200 && statusCode <= 299) {
    return {
      classification: 'accepted',
      status: 'waiting_callback',
      submittedAtIso: nowIso,
      callbackDeadlineAtIso: attempt <= sttRetryPolicy(requestType).slots.length + 1
        ? (sttRetryTiming(requestCreatedAtIso, attempt, requestType).nextRetryAtIso || sttRetryTiming(requestCreatedAtIso, attempt, requestType).deadlineAtIso)
        : addMinutes(nowIso, 24 * 60),
    };
  }
  if (statusCode >= 400 && statusCode <= 499 && statusCode !== 429) {
    return { classification: 'terminal_http_failure', status: 'failed', errorCode: `vds_http_${statusCode}`, nextRetryAtIso: '' };
  }
  if (RETRYABLE_HTTP_STATUSES.has(statusCode)) {
    const timing = sttRetryTiming(requestCreatedAtIso, attempt, requestType);
    const maximumAttempts = sttRetryPolicy(requestType).slots.length + 1;
    if (attempt >= maximumAttempts || strictIso(nowIso, 'current time') >= strictIso(timing.deadlineAtIso, 'retry deadline')) return { classification: 'retry_exhausted', status: 'failed', errorCode: `vds_http_${statusCode}`, nextRetryAtIso: '' };
    return { classification: 'retryable_http_failure', status: 'retry_pending', errorCode: `vds_http_${statusCode}`, nextRetryAtIso: timing.nextRetryAtIso };
  }
  if (statusCode >= 500) {
    return {
      classification: 'unclassified_server_failure',
      status: 'manual_review',
      manualReviewReason: 'vds_http_unclassified_server_response',
      manualReviewAtIso: nowIso,
      nextRetryAtIso: '',
      errorCode: `vds_http_${statusCode}`,
    };
  }
  return {
    classification: 'ambiguous_transport',
    status: 'manual_review',
    manualReviewReason: 'vds_submit_outcome_ambiguous',
    manualReviewAtIso: nowIso,
    nextRetryAtIso: '',
    errorCode: '',
  };
}

function planAttemptFailurePatch(attempt, outcome, nowIso = new Date().toISOString(), requestRow) {
  validateAttemptRow(attempt);
  const result = classifyAttemptFailure(outcome, attempt.attempt, nowIso, requestRow?.createdAt || nowIso, requestRow?.requestType || attempt.requestType);
  const filters = {
    id: attempt.id,
    attemptKey: attempt.attemptKey,
    reconciliationStatus: 'canonical',
    canonicalRowID: String(attempt.id),
    status: attempt.status,
  };
  const desired = { status: result.status, updatedAtIso: nowIso };
  if (result.errorCode) desired.errorCode = result.errorCode;
  if (result.status === 'retry_pending') desired.nextRetryAtIso = result.nextRetryAtIso;
  if (result.status === 'manual_review') {
    desired.manualReviewReason = result.manualReviewReason;
    desired.manualReviewAtIso = result.manualReviewAtIso;
    desired.nextRetryAtIso = '';
  }
  if (result.status === 'waiting_callback') {
    desired.submittedAtIso = result.submittedAtIso;
    desired.callbackDeadlineAtIso = result.callbackDeadlineAtIso;
  }
  if (attempt.status === 'dispatching') {
    desired.dispatchLeaseOwner = '';
    desired.dispatchLeaseUntilIso = '';
  }
  return {
    action: result.classification,
    repairClass: 'attempt_failure_patch',
    classification: result.classification,
    status: result.status,
    errorCode: result.errorCode || '',
    nextRetryAtIso: result.nextRetryAtIso || '',
    filters,
    desired,
  };
}

function planSummaryFailurePatch(request, nowIso = new Date().toISOString(), reason) {
  validateRequestRow(request);
  strictIso(nowIso, 'current time');
  if (request.status !== 'summary_dispatching') throw new Error('Summary failure patch requires summary_dispatching');
  if (!nonempty(request.leaseOwner)) throw new Error('Summary failure patch requires an exact lease owner');
  const summaryAttempt = Number(request.summaryAttempt || 0);
  if (!Number.isInteger(summaryAttempt) || summaryAttempt < 0 || summaryAttempt > 2) throw new Error('Invalid summary attempt');
  const next = summaryAttempt + 1;
  const terminal = next >= 3;
  const filters = {
    id: request.id,
    requestKey: request.requestKey,
    status: 'summary_dispatching',
    reconciliationStatus: 'canonical',
    canonicalRowID: String(request.id),
    leaseOwner: request.leaseOwner,
    leaseUntilIso: request.leaseUntilIso,
    summaryAttempt,
  };
  const desired = {
    status: terminal ? 'failed' : 'summary_retry_pending',
    summaryAttempt: next,
    nextRetryAtIso: terminal ? '' : addMinutes(nowIso, nextRetryDelayMs(next) / 60_000),
    errorCode: String(reason || 'summary_failed').slice(0, 80),
    leaseOwner: '',
    leaseUntilIso: '',
    updatedAtIso: nowIso,
  };
  return {
    action: terminal ? 'fail' : 'schedule_retry',
    repairClass: 'summary_failure_patch',
    summaryAttempt: next,
    nextRetryDelayMs: terminal ? 0 : nextRetryDelayMs(next),
    filters,
    desired,
  };
}

function planRetry(attempt) {
  validateAttemptRow(attempt);
  const attemptNumber = Number(attempt.attempt);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber >= MAX_AUTOMATIC_ATTEMPTS) throw new Error('Attempt retry is terminal or invalid');
  return {
    claimStatus: 'retry_materializing',
    nextAttempt: attemptNumber + 1,
    nextAttemptKey: `${attempt.logicalJobKey}:${attemptNumber + 1}`,
    nextRetryDelayMs: sttRetryDelayMs(attemptNumber),
  };
}

function planRetryMaterializationClaim(oldAttempt, nowIso = new Date().toISOString(), leaseOwner, requestRow) {
  validateAttemptRow(oldAttempt);
  strictIso(nowIso, 'current time');
  if (typeof leaseOwner !== 'string' || leaseOwner === '') throw new Error('Retry lease owner is required');
  const status = oldAttempt.status;
  if (status !== 'retry_pending' && status !== 'retry_materializing') throw new Error('Retry materialization requires retry_pending or retry_materializing');
  const attemptNumber = Number(oldAttempt.attempt);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber >= MAX_AUTOMATIC_ATTEMPTS) throw new Error('Attempt retry is terminal or invalid');
  const now = Date.parse(nowIso);
  const owner = oldAttempt.retryLeaseOwner || '';
  const until = oldAttempt.retryLeaseUntilIso || '';
  const untilParsed = until === '' ? Number.POSITIVE_INFINITY : Date.parse(until);
  if (until !== '' && !Number.isFinite(untilParsed)) throw new Error('Invalid retry lease expiry');
  if (status === 'retry_pending') {
    const due = Date.parse(oldAttempt.nextRetryAtIso);
    if (!Number.isFinite(due)) throw new Error('Invalid next retry time');
    if (due > now) return { action: 'noop', repairClass: 'retry_materialization', reason: 'retry_not_due' };
    if (owner !== '' || until !== '') throw new Error('Retry pending lease pair is malformed');
  } else if (owner === '' || until === '' || !Number.isFinite(untilParsed)) {
    throw new Error('Retry materializing lease pair is malformed');
  } else if (untilParsed > now) {
    return { action: 'noop', repairClass: 'retry_materialization', reason: 'retry_lease_active' };
  }
  const timingSource = oldAttempt.requestType === 'standalone_stt' ? oldAttempt : requestRow;
  if (!timingSource || timingSource.requestKey !== oldAttempt.requestKey) throw new Error('Retry materialization requires canonical request');
  if (timingSource !== oldAttempt) validateRequestRow(timingSource);
  const timing = sttRetryTiming(timingSource.createdAt, attemptNumber, timingSource.requestType);
  if (now >= Date.parse(timing.deadlineAtIso)) {
    return {
      action: 'deadline_exhausted',
      repairClass: 'retry_materialization',
      filters: {
        id: oldAttempt.id,
        attemptKey: oldAttempt.attemptKey,
        status,
        reconciliationStatus: 'canonical',
        canonicalRowID: String(oldAttempt.id),
        nextRetryAtIso: oldAttempt.nextRetryAtIso,
        retryLeaseOwner: owner,
        retryLeaseUntilIso: until,
      },
      desired: {
        status: 'timed_out',
        errorCode: 'stt_retry_deadline_exceeded',
        nextRetryAtIso: '',
        retryLeaseOwner: '',
        retryLeaseUntilIso: '',
        updatedAtIso: nowIso,
      },
    };
  }
  const intent = planRetry(oldAttempt);
  const filters = {
    id: oldAttempt.id,
    attemptKey: oldAttempt.attemptKey,
    status,
    reconciliationStatus: 'canonical',
    canonicalRowID: String(oldAttempt.id),
    nextRetryAtIso: oldAttempt.nextRetryAtIso,
    retryLeaseOwner: owner,
    retryLeaseUntilIso: until,
  };
  const retryLeaseUntilIso = addMinutes(nowIso, 24 * 60);
  return {
    action: 'claim',
    repairClass: 'retry_materialization',
    claimStatus: intent.claimStatus,
    nextAttempt: intent.nextAttempt,
    nextAttemptKey: intent.nextAttemptKey,
    nextRetryDelayMs: intent.nextRetryDelayMs,
    leaseOwner,
    retryLeaseUntilIso,
    filters,
    desired: { status: 'retry_materializing', retryLeaseOwner: leaseOwner, retryLeaseUntilIso },
  };
}

function buildNextAttempt(oldAttempt, nowIso = new Date().toISOString()) {
  validateAttemptRow(oldAttempt);
  strictIso(nowIso, 'current time');
  const attemptNumber = Number(oldAttempt.attempt);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber >= MAX_AUTOMATIC_ATTEMPTS) throw new Error('Attempt retry is terminal or invalid');
  const next = attemptNumber + 1;
  const attempt = {
    attemptKey: `${oldAttempt.logicalJobKey}:${next}`,
    logicalJobKey: oldAttempt.logicalJobKey,
    requestKey: oldAttempt.requestKey,
    requestType: oldAttempt.requestType,
    attempt: next,
    role: oldAttempt.role,
    streamID: oldAttempt.streamID,
    mode: oldAttempt.mode,
    durationMinutes: oldAttempt.durationMinutes,
    streamContextJson: oldAttempt.streamContextJson,
    status: 'queued',
    callbackTokenHash: '',
    reconciliationStatus: 'pending',
    canonicalRowID: '',
    dispatchLeaseOwner: '',
    dispatchLeaseUntilIso: '',
    submittedAtIso: '',
    callbackDeadlineAtIso: '',
    manualReviewReason: '',
    manualReviewAtIso: '',
    manualReviewResolution: '',
    callbackTokenExpiresAtIso: '',
    consumedAtIso: '',
    channel: oldAttempt.channel,
    threadTS: oldAttempt.threadTS,
    processingMessageTS: oldAttempt.processingMessageTS,
    dialogue: '',
    language: '',
    errorCode: '',
    nextRetryAtIso: '',
    retryLeaseOwner: '',
    retryLeaseUntilIso: '',
    duplicateCount: 0,
    presentationStatus: 'pending',
    presentationLeaseOwner: '',
    presentationLeaseUntilIso: '',
    presentationAttempt: 0,
    presentationNextRetryAtIso: '',
    presentationErrorCode: '',
    transcriptUploadID: '',
    analysisUploadID: '',
    processingMessageUpdatedAtIso: '',
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  };
  if (Object.keys(attempt).length !== ATTEMPT_FIELDS.length
    || ATTEMPT_FIELDS.some((field, index) => Object.keys(attempt)[index] !== field)) throw new Error('Attempt schema drift');
  return attempt;
}

function planNextAttemptReconciliation(rows, expected, summaryRows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return { action: 'insert', expected };
  if (!expected || typeof expected !== 'object') throw new Error('Expected next attempt is required');
  const requestKey = rows[0].requestKey;
  for (const row of rows) {
    validateAttemptRow(row);
    if (row.attemptKey !== expected.attemptKey) throw new Error('Invalid same-key row set');
    if (row.requestKey !== requestKey) throw new Error('Attempt request key mismatch');
    immutableAttemptMatches(row, expected);
  }
  const summaries = meaningfulRows(summaryRows);
  for (const summary of summaries) {
    if (summary.requestKey !== requestKey) throw new Error('Summary request key mismatch');
  }
  const canonicals = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  if (canonicals.length > 1) {
    const checkpointed = rows.some((row) => hasCheckpoint(row, ATTEMPT_CHECKPOINT_FIELDS))
      || summaries.some((row) => hasCheckpoint(row, SUMMARY_CHECKPOINT_FIELDS));
    if (checkpointed) {
      return {
        action: 'manual_review',
        reason: 'multiple_canonical_checkpoint_conflict',
        mutations: canonicals.map((row) => ({
          id: row.id,
          attemptKey: row.attemptKey,
          expectedStatus: row.status,
          expectedReconciliationStatus: 'canonical',
          expectedCanonicalRowID: String(row.id),
          desiredStatus: 'manual_review',
          desiredReconciliationStatus: 'canonical',
        })),
      };
    }
    const [winner, ...losers] = [...canonicals].sort(compareRows);
    return {
      action: 'reconcile',
      winnerRowID: winner.id,
      mutations: losers.map((row) => ({
        id: row.id,
        attemptKey: row.attemptKey,
        expectedStatus: row.status,
        expectedReconciliationStatus: 'canonical',
        expectedCanonicalRowID: String(row.id),
        desiredReconciliationStatus: 'duplicate',
        desiredCanonicalRowID: String(winner.id),
      })),
    };
  }
  if (canonicals.length === 1) {
    const canonical = canonicals[0];
    const mutations = rows
      .filter((row) => row.id !== canonical.id)
      .filter((row) => row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(canonical.id))
      .map((row) => ({
        id: row.id,
        attemptKey: row.attemptKey,
        expectedStatus: row.status,
        expectedReconciliationStatus: row.reconciliationStatus,
        expectedCanonicalRowID: row.canonicalRowID || '',
        desiredReconciliationStatus: 'duplicate',
        desiredCanonicalRowID: String(canonical.id),
      }));
    return mutations.length
      ? { action: 'reconcile', winnerRowID: canonical.id, mutations }
      : { action: 'ready', winnerRowID: canonical.id, canonical, mutations: [] };
  }
  const [winner] = [...rows].sort(compareRows);
  return {
    action: 'reconcile',
    winnerRowID: winner.id,
    mutations: rows.map((row) => ({
      id: row.id,
      attemptKey: row.attemptKey,
      expectedStatus: row.status,
      expectedReconciliationStatus: row.reconciliationStatus,
      expectedCanonicalRowID: row.canonicalRowID || '',
      desiredReconciliationStatus: row.id === winner.id ? 'canonical' : 'duplicate',
      desiredCanonicalRowID: String(winner.id),
    })),
  };
}

function verifyNextRows(rows, plan) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Next attempt rows not found');
  rows.forEach(validateAttemptRow);
  const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
  if (plan?.action === 'manual_review') {
    const expectedIDs = (plan.mutations || []).map(({ id }) => id);
    if (canonicals.length !== expectedIDs.length) throw new Error('Next attempt freeze is incomplete');
    for (const row of canonicals) {
      if (!expectedIDs.includes(row.id) || row.status !== 'manual_review' || row.manualReviewReason !== 'multiple_canonical_checkpoint_conflict') {
        throw new Error('Next attempt freeze mismatch');
      }
    }
    return { action: 'verified_frozen' };
  }
  if (canonicals.length !== 1) throw new Error('Next attempt requires exactly one canonical');
  const canonical = canonicals[0];
  if (plan?.expected && canonical.attemptKey !== plan.expected.attemptKey) throw new Error('Next attempt key mismatch');
  if (plan?.winnerRowID && canonical.id !== plan.winnerRowID) throw new Error('Next attempt winner mismatch');
  if (rows.some((row) => row.id !== canonical.id && (row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(canonical.id)))) {
    throw new Error('Next attempt loser linkage mismatch');
  }
  return { action: 'verified', canonical };
}

function planAutoRetryOldTransition(oldAttempt, nextAttemptKey, nowIso = new Date().toISOString()) {
  validateAttemptRow(oldAttempt);
  strictIso(nowIso, 'current time');
  if (oldAttempt.status !== 'retry_materializing') throw new Error('Old attempt is not retry_materializing');
  if (!nonempty(nextAttemptKey)) throw new Error('Next attempt key is required');
  const owner = oldAttempt.retryLeaseOwner || '';
  const until = oldAttempt.retryLeaseUntilIso || '';
  if (owner === '' || until === '') throw new Error('Retry lease pair is malformed');
  return {
    action: 'transition',
    repairClass: 'retry_materialization',
    filters: {
      id: oldAttempt.id,
      attemptKey: oldAttempt.attemptKey,
      status: 'retry_materializing',
      reconciliationStatus: 'canonical',
      canonicalRowID: String(oldAttempt.id),
      retryLeaseOwner: owner,
      retryLeaseUntilIso: until,
    },
    desired: {
      status: 'retry_materialized',
      retryLeaseOwner: '',
      retryLeaseUntilIso: '',
      manualReviewResolution: `retry_created:${nextAttemptKey}`,
      updatedAtIso: nowIso,
    },
  };
}

function verifyOldTransition(rows, plan) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Old attempt rows not found');
  rows.forEach(validateAttemptRow);
  const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
  if (canonicals.length !== 1) throw new Error('Old attempt requires exactly one canonical');
  const row = canonicals[0];
  if (plan?.filters?.id && row.id !== plan.filters.id) throw new Error('Old attempt identity mismatch');
  if (row.status !== 'retry_materialized') throw new Error('Old attempt transition not verified');
  if (row.manualReviewResolution !== plan?.desired?.manualReviewResolution) throw new Error('Old attempt resolution link mismatch');
  if (row.retryLeaseOwner !== '' || row.retryLeaseUntilIso !== '') throw new Error('Old attempt retry lease was not cleared');
  return { action: 'verified', canonical: row };
}

function planAttemptManualResolution(attempt, approval, nowIso = new Date().toISOString()) {
  validateAttemptRow(attempt);
  strictIso(nowIso, 'current time');
  if (!approval?.approved || !nonempty(approval.approvalRef)) throw new Error('Production approval reference required');
  if (attempt.status !== 'manual_review') throw new Error('Manual resolution requires manual_review status');
  if (attempt.reconciliationStatus !== 'canonical' || attempt.canonicalRowID !== String(attempt.id)) throw new Error('Manual resolution requires canonical row');
  const existing = attempt.manualReviewResolution || '';
  if (existing !== '') {
    const resolvedDecision = existing.startsWith('retry_created:') ? 'retry' : existing.startsWith('attempt_failed:') ? 'failed' : '';
    if (resolvedDecision === '') throw new Error('Invalid persisted manual resolution');
    if (approval.decision && approval.decision !== resolvedDecision) throw new Error('Attempt manual resolution decision is immutable');
    return {
      action: 'resolved',
      resolution: existing,
      nextAttemptKey: resolvedDecision === 'retry' ? existing.slice('retry_created:'.length) : '',
      createsSttAttempt: false,
    };
  }
  const filters = {
    id: attempt.id,
    attemptKey: attempt.attemptKey,
    status: 'manual_review',
    reconciliationStatus: 'canonical',
    canonicalRowID: String(attempt.id),
    manualReviewResolution: '',
  };
  if (approval.decision === 'failed') {
    return {
      action: 'failed',
      repairClass: 'attempt_manual_resolution',
      filters,
      desired: {
        status: 'failed',
        manualReviewResolution: 'attempt_failed:manual_decision',
        errorCode: attempt.errorCode || 'manual_review_failed',
        manualReviewAtIso: attempt.manualReviewAtIso || nowIso,
        updatedAtIso: nowIso,
      },
      createsSttAttempt: false,
      nextAttemptKey: '',
    };
  }
  if (approval.decision === 'retry') {
    const intent = planRetry(attempt);
    return {
      action: 'retry',
      repairClass: 'attempt_manual_resolution',
      nextAttempt: intent.nextAttempt,
      nextAttemptKey: intent.nextAttemptKey,
      nextRetryDelayMs: intent.nextRetryDelayMs,
      filters,
      desiredNext: buildNextAttempt(attempt, nowIso),
      createsSttAttempt: false,
    };
  }
  throw new Error('Invalid manual resolution decision');
}

function planManualRetryOldTransition(oldAttempt, nextAttemptKey, approval, nowIso = new Date().toISOString()) {
  validateAttemptRow(oldAttempt);
  strictIso(nowIso, 'current time');
  if (oldAttempt.status !== 'manual_review') throw new Error('Manual retry old row is not manual_review');
  if (!approval?.approved || !nonempty(approval.approvalRef)) throw new Error('Production approval reference required');
  if (!nonempty(nextAttemptKey)) throw new Error('Next attempt key is required');
  return {
    action: 'transition',
    repairClass: 'attempt_manual_resolution',
    filters: {
      id: oldAttempt.id,
      attemptKey: oldAttempt.attemptKey,
      status: 'manual_review',
      reconciliationStatus: 'canonical',
      canonicalRowID: String(oldAttempt.id),
      manualReviewResolution: '',
    },
    desired: {
      status: 'retry_materialized',
      manualReviewResolution: `retry_created:${nextAttemptKey}`,
      retryLeaseOwner: '',
      retryLeaseUntilIso: '',
      updatedAtIso: nowIso,
    },
  };
}

function checkpointVector(row) {
  return SUMMARY_CHECKPOINT_FIELDS.map((key) => row[key] || '');
}

function sameVector(left, right) {
  return checkpointVector(left).every((value, index) => value === checkpointVector(right)[index]);
}

function planRequestResolution(rows, approval) {
  validateRequestRows(rows, rows[0]?.requestKey);
  if (!approval?.approved || !nonempty(approval.approvalRef)) throw new Error('Production approval reference required');
  const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonical.length === 0) throw new Error('Resolution requires canonical rows');
  const fixed = canonical.find((row) => nonempty(row.manualResolutionDecisionID) || nonempty(row.manualResolutionWinnerRowID));
  if (fixed && (!nonempty(fixed.manualResolutionDecisionID) || !nonempty(fixed.manualResolutionWinnerRowID))) throw new Error('Incomplete immutable resolution decision');
  if (fixed && ((approval.decisionID && approval.decisionID !== fixed.manualResolutionDecisionID) || (approval.winnerRowID && approval.winnerRowID !== fixed.manualResolutionWinnerRowID))) {
    throw new Error('Resolution decision is immutable');
  }
  const checkpoints = canonical.filter((row) => hasCheckpoint(row, SUMMARY_CHECKPOINT_FIELDS));
  let winner;
  let selectionReason;
  if (fixed) {
    winner = rows.find((row) => String(row.id) === fixed.manualResolutionWinnerRowID);
    if (!winner) throw new Error('Fixed resolution winner missing');
  } else if (approval.decision === 'failed') {
    winner = [...canonical].sort(compareRows)[0];
    selectionReason = 'explicit_request_failure';
  } else if (checkpoints.length === 1) {
    winner = checkpoints[0];
    selectionReason = 'only_checkpoint';
  } else if (checkpoints.length > 1 && checkpoints.every((row) => sameVector(row, checkpoints[0]))) {
    winner = [...checkpoints].sort(compareRows)[0];
    selectionReason = 'identical_checkpoints_system_earliest';
  } else if (nonempty(approval.winnerRowID) && canonical.some((row) => String(row.id) === approval.winnerRowID)) {
    winner = canonical.find((row) => String(row.id) === approval.winnerRowID);
    selectionReason = 'explicit_checkpoint_winner';
  } else {
    throw new Error('Conflicting checkpoints need explicit winner');
  }
  if (!REQUEST_STAGES.has(winner.manualReviewOriginalStage)) throw new Error('Invalid manual review original stage');
  const decisionID = fixed ? fixed.manualResolutionDecisionID : approval.decisionID;
  if (!nonempty(decisionID)) throw new Error('Resolution decision ID required');
  const failed = approval.decision === 'failed';
  if (!fixed) {
    return {
      action: 'persist_decision',
      requestKey: rows[0].requestKey,
      winnerRowID: winner.id,
      decisionID,
      resumeStatus: winner.manualReviewOriginalStage,
      selectionReason,
      failed,
      createsSttAttempt: false,
      expected: {
        status: 'manual_review',
        reconciliationStatus: 'canonical',
        canonicalRowID: String(winner.id),
        manualResolutionDecisionID: '',
        manualResolutionWinnerRowID: '',
      },
    };
  }
  const losers = rows.filter((row) => row.id !== winner.id);
  const pending = losers.filter((row) => !(row.reconciliationStatus === 'duplicate' && row.canonicalRowID === String(winner.id) && row.manualResolutionDecisionID === decisionID));
  if (pending.length) {
    return {
      action: 'patch_losers',
      requestKey: rows[0].requestKey,
      winnerRowID: winner.id,
      decisionID,
      resumeStatus: winner.manualReviewOriginalStage,
      createsSttAttempt: false,
      mutations: pending.sort(compareRows).map((row) => ({
        id: row.id,
        requestKey: row.requestKey,
        expectedStatus: row.status,
        expectedReconciliationStatus: row.reconciliationStatus,
        expectedCanonicalRowID: row.canonicalRowID || '',
        expectedUpdatedAt: row.updatedAt,
        desiredReconciliationStatus: 'duplicate',
        desiredCanonicalRowID: String(winner.id),
        manualResolutionDecisionID: decisionID,
      })),
    };
  }
  return {
    action: 'finalize',
    requestKey: rows[0].requestKey,
    winnerRowID: winner.id,
    decisionID,
    resumeStatus: failed ? 'failed' : winner.manualReviewOriginalStage,
    failed,
    createsSttAttempt: false,
    expected: {
      status: 'manual_review',
      reconciliationStatus: 'canonical',
      canonicalRowID: String(winner.id),
      manualResolutionDecisionID: decisionID,
      manualResolutionWinnerRowID: String(winner.id),
    },
    manualReviewResolution: failed ? 'request_failed:checkpoint_conflict' : `winner_selected:${winner.id}:resume:${winner.manualReviewOriginalStage}`,
  };
}

function runRequestResolution(rows, approval, options = {}) {
  const next = rows.map((row) => ({ ...row }));
  let sideEffectCalls = 0;
  let reElected = false;
  for (;;) {
    const plan = planRequestResolution(next, approval);
    if (plan.action === 'persist_decision') {
      const winner = next.find((row) => row.id === plan.winnerRowID);
      winner.manualResolutionDecisionID = plan.decisionID;
      winner.manualResolutionWinnerRowID = String(winner.id);
      continue;
    }
    if (plan.action === 'patch_losers') {
      for (const mutation of plan.mutations) {
        if (options.failLoserID === mutation.id) {
          return {
            rows: next,
            winner: next.find((row) => row.id === plan.winnerRowID),
            losers: next.filter((row) => row.id !== plan.winnerRowID),
            canonicalRows: next.filter((row) => row.reconciliationStatus === 'canonical'),
            sideEffectCalls,
            sideEffectCallsBeforeFinalPatch: sideEffectCalls,
            reElected,
          };
        }
        const row = next.find((candidate) => candidate.id === mutation.id);
        row.reconciliationStatus = 'duplicate';
        row.canonicalRowID = String(plan.winnerRowID);
        row.manualResolutionDecisionID = plan.decisionID;
        row.manualResolutionWinnerRowID = String(plan.winnerRowID);
      }
      continue;
    }
    if (options.crashBeforeWinnerFinalPatch) {
      return {
        rows: next,
        winner: next.find((row) => row.id === plan.winnerRowID),
        losers: next.filter((row) => row.id !== plan.winnerRowID),
        canonicalRows: next.filter((row) => row.reconciliationStatus === 'canonical'),
        sideEffectCalls,
        sideEffectCallsBeforeFinalPatch: sideEffectCalls,
        reElected,
      };
    }
    const winner = next.find((row) => row.id === plan.winnerRowID);
    winner.status = plan.resumeStatus;
    winner.manualReviewResolution = plan.manualReviewResolution;
    if (winner.status === 'ready') {
      winner.leaseOwner = '';
      winner.leaseUntilIso = '';
    }
    if (winner.status === 'summary_dispatching') {
      winner.leaseOwner = '';
      winner.leaseUntilIso = options.resolutionIso || RESOLUTION_EPOCH_ISO;
    }
    if (winner.status === 'summary_retry_pending') {
      winner.leaseOwner = '';
      winner.leaseUntilIso = '';
    }
    return {
      rows: next,
      winner,
      losers: next.filter((row) => row.id !== winner.id),
      canonicalRows: next.filter((row) => row.reconciliationStatus === 'canonical'),
      sideEffectCalls,
      sideEffectCallsBeforeFinalPatch: sideEffectCalls,
      reElected,
    };
  }
}

function maskedAuditPlans(rows, plan, approval) {
  if (!plan || !Array.isArray(rows)) return [];
  const requestKey = plan.requestKey || rows[0]?.requestKey;
  const decisionID = plan.decisionID || '';
  const winnerRowID = plan.winnerRowID || '';
  const nowIso = plan.nowIso || new Date().toISOString();
  return rows.map((row) => ({
    action: 'write_audit',
    columns: {
      errorKey: `audit:v1:${fnv1a([requestKey, row.id, decisionID, approval?.approvalRef || ''].join('|'))}`,
      component: 'repair_request_resolution',
      reconciliationStatus: 'pending',
      canonicalRowID: '',
      requestKey: requestKey || '',
      logicalJobKey: '',
      attemptKey: '',
      executionID: '',
      workflowName: 'Automation: retry and repair v3',
      nodeName: 'Plan Repairs',
      errorCode: 'request_manual_resolution_audit',
      messageMasked: maskText(`decision=${decisionID} winner=${winnerRowID} row=${row.id} originalStage=${row.manualReviewOriginalStage || ''} checkpointDigest=${fnv1a(checkpointVector(row).join('\u0000'))} approval=${approval?.approvalRef || ''}`),
      retryable: false,
      createdAtIso: nowIso,
    },
  }));
}

function planPresentationRepair(attempt, nowIso = new Date().toISOString()) {
  validateAttemptRow(attempt);
  strictIso(nowIso, 'current time');
  if (!['completed', 'failed', 'timed_out'].includes(attempt.status)) throw new Error('Presentation repair requires a terminal attempt');
  const presentationAttempt = Number(attempt.presentationAttempt || 0);
  if (!Number.isInteger(presentationAttempt) || presentationAttempt < 0) throw new Error('Invalid presentation attempt');
  if (presentationAttempt >= 3) throw new Error('Presentation attempt cap reached');
  const now = Date.parse(nowIso);
  const owner = attempt.presentationLeaseOwner || '';
  const until = attempt.presentationLeaseUntilIso || '';
  const untilParsed = until === '' ? Number.POSITIVE_INFINITY : Date.parse(until);
  if (until !== '' && !Number.isFinite(untilParsed)) throw new Error('Invalid presentation lease expiry');
  if (attempt.presentationStatus === 'retry_pending') {
    const due = Date.parse(attempt.presentationNextRetryAtIso || '');
    if (!Number.isFinite(due)) throw new Error('Invalid presentation retry time');
    if (due > now) return { action: 'noop', repairClass: 'presentation_lease', reason: 'presentation_retry_not_due' };
    if (owner !== '' || until !== '') throw new Error('Presentation retry lease pair is malformed');
  } else if (attempt.presentationStatus === 'presenting') {
    if (owner === '' || until === '' || !Number.isFinite(untilParsed)) throw new Error('Presentation presenting lease pair is malformed');
    if (untilParsed > now) return { action: 'noop', repairClass: 'presentation_lease', reason: 'presentation_lease_active' };
  } else {
    return { action: 'noop', repairClass: 'presentation_lease', reason: 'presentation_not_repairable' };
  }
  return {
    action: 'claim',
    repairClass: 'presentation_lease',
    filters: {
      id: attempt.id,
      attemptKey: attempt.attemptKey,
      reconciliationStatus: 'canonical',
      canonicalRowID: String(attempt.id),
      status: attempt.status,
      presentationStatus: attempt.presentationStatus,
      presentationAttempt,
      presentationLeaseOwner: owner,
      presentationLeaseUntilIso: until,
    },
    desired: {
      presentationStatus: 'pending',
      presentationLeaseOwner: '',
      presentationLeaseUntilIso: '',
      updatedAtIso: nowIso,
    },
  };
}

function verifyPresentationRepair(rows, plan) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Presentation repair rows not found');
  rows.forEach(validateAttemptRow);
  const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
  if (canonicals.length !== 1) throw new Error('Presentation repair requires exactly one canonical');
  const row = canonicals[0];
  if (plan?.filters?.id && row.id !== plan.filters.id) throw new Error('Presentation repair identity mismatch');
  if (!['completed', 'failed', 'timed_out'].includes(row.status) || row.presentationStatus !== 'pending') throw new Error('Presentation repair transition not verified');
  if (row.presentationLeaseOwner !== '' || row.presentationLeaseUntilIso !== '') throw new Error('Presentation repair lease was not cleared');
  return { action: 'verified', canonical: row };
}

function planPresentationOwnerCall(attempt) {
  validateAttemptRow(attempt);
  if (!['completed', 'failed', 'timed_out'].includes(attempt.status) || attempt.presentationStatus !== 'pending') throw new Error('Presentation owner call requires verified pending transition');
  return {
    action: 'call_owner',
    repairClass: 'presentation_lease',
    targetWorkflow: 'STTListenerV3A01',
    input: { attemptKey: attempt.attemptKey },
    requiresPreflight: true,
  };
}

function planMissedEvent(kind, row, context = {}, nowIso = new Date().toISOString()) {
  strictIso(nowIso, 'current time');
  if (kind === 'dispatch_queued') {
    if (row.status !== 'queued') throw new Error('Dispatch missed event requires queued status');
    if (!context.postTransitionVerified) throw new Error('Dispatch missed event requires verified post-transition state');
    if (nonempty(row.dispatchLeaseOwner) || nonempty(row.dispatchLeaseUntilIso)) throw new Error('Dispatch missed event has an active dispatch lease');
    return {
      action: 'call_dispatcher',
      targetWorkflow: 'STTDispatchV3A01',
      input: { attemptKey: row.attemptKey },
      requiresPreflight: true,
    };
  }
  if (kind === 'coordinator_waiting_stt') {
    if (row.status !== 'waiting_stt') throw new Error('Coordinator waiting_stt event requires waiting_stt');
    return {
      action: 'call_coordinator',
      targetWorkflow: 'SummaryCoordV3A1',
      input: { requestKey: row.requestKey },
      requiresPreflight: true,
    };
  }
  if (kind === 'coordinator_ready') {
    if (row.status !== 'ready') throw new Error('Coordinator ready event requires ready');
    if (nonempty(row.leaseOwner) && nonempty(row.leaseUntilIso) && Date.parse(row.leaseUntilIso) > Date.parse(nowIso)) {
      throw new Error('Coordinator ready event has an active summary lease');
    }
    return {
      action: 'call_coordinator',
      targetWorkflow: 'SummaryCoordV3A1',
      input: { requestKey: row.requestKey },
      requiresPreflight: true,
    };
  }
  if (kind === 'coordinator_summary_expired') {
    if (row.status !== 'summary_dispatching') throw new Error('Coordinator summary expired event requires summary_dispatching');
    if (!nonempty(row.leaseOwner) || !nonempty(row.leaseUntilIso)) throw new Error('Coordinator summary expired event needs an exact lease pair');
    if (Date.parse(row.leaseUntilIso) > Date.parse(nowIso)) throw new Error('Coordinator summary lease is not expired');
    return {
      action: 'call_coordinator',
      targetWorkflow: 'SummaryCoordV3A1',
      input: { requestKey: row.requestKey },
      requiresPreflight: true,
    };
  }
  if (kind === 'presentation_owner') {
    if (!['completed', 'failed', 'timed_out'].includes(row.status)) throw new Error('Presentation owner event requires terminal attempt');
    return {
      action: 'call_owner',
      targetWorkflow: 'STTListenerV3A01',
      input: { attemptKey: row.attemptKey },
      requiresPreflight: true,
    };
  }
  throw new Error('Unknown missed event kind');
}

function retryTarget(row, attempts) {
  const resolution = row.manualReviewResolution || '';
  const match = /^retry_created:(.+):(\d+)$/.exec(resolution);
  if (!match || match[1] !== row.logicalJobKey || Number(match[2]) !== row.attempt + 1) throw new Error('broken retry materialization chain');
  const nextKey = `${row.logicalJobKey}:${row.attempt + 1}`;
  const targets = attempts.filter((candidate) => candidate.attemptKey === nextKey && candidate.reconciliationStatus === 'canonical');
  if (targets.length !== 1 || targets[0].attempt !== row.attempt + 1) throw new Error('broken retry materialization chain');
  return targets[0];
}

function aggregateLogicalJobs(request, rows) {
  validateRequestRow(request);
  const streams = parseOrderedStreams(request);
  const existing = parseExistingDialogues(request);
  const expected = parseExpectedLogicalJobKeys(request, streams, existing);
  if (!Array.isArray(rows)) throw new Error('attempt rows must be an array');
  const grouped = new Map();
  for (const row of rows.filter((candidate) => candidate && candidate.id)) {
    validateAttemptRow(row);
    if (row.requestKey !== request.requestKey || !expected.includes(row.logicalJobKey)) throw new Error('attempt request linkage mismatch');
    const group = grouped.get(row.attemptKey) || [];
    group.push(row);
    grouped.set(row.attemptKey, group);
  }
  const canonicalByLogical = new Map();
  for (const group of grouped.values()) {
    const canonical = group.filter((row) => row.reconciliationStatus === 'canonical');
    if (canonical.length !== 1) throw new Error('attempt key must have exactly one canonical');
    if (group.some((row) => row.reconciliationStatus === 'duplicate' && row.canonicalRowID !== String(canonical[0].id))) throw new Error('attempt duplicate canonical linkage mismatch');
    const list = canonicalByLogical.get(canonical[0].logicalJobKey) || [];
    list.push(canonical[0]);
    canonicalByLogical.set(canonical[0].logicalJobKey, list);
  }
  const available = new Map();
  const failed = [];
  const unresolved = [];
  const hardFailed = new Set();
  for (const stream of streams) {
    const key = `${request.requestKey}:${stream.role}:${stream.liveStreamID}:${stream.mode}`;
    const persisted = existing[stream.role];
    if (persisted) {
      available.set(key, { stream, dialogue: persisted.dialogue });
      continue;
    }
    if (!expected.includes(key)) continue;
    const attempts = canonicalByLogical.get(key) || [];
    if (!attempts.length) throw new Error('missing canonical attempt');
    const successes = attempts.filter((row) => row.status === 'completed');
    if (successes.length) {
      available.set(key, { stream, dialogue: [...successes].sort((a, b) => a.attempt - b.attempt || compareRows(a, b))[0].dialogue });
      continue;
    }
    const retryRows = attempts.filter((row) => row.status === 'retry_materialized' || (row.status === 'manual_review' && nonempty(row.manualReviewResolution)));
    retryRows.forEach((row) => retryTarget(row, attempts));
    const activeAttempts = attempts.filter((row) => !retryRows.includes(row));
    if (activeAttempts.some((row) => PENDING_ATTEMPT_STATUSES.has(row.status) || (row.status === 'manual_review' && !nonempty(row.manualReviewResolution)))) {
      unresolved.push(key);
      continue;
    }
    if (activeAttempts.some((row) => row.status === 'timed_out')) {
      failed.push(key);
      continue;
    }
    if (activeAttempts.length && activeAttempts.every((row) => TERMINAL_ATTEMPT_STATUSES.has(row.status))) {
      failed.push(key);
      hardFailed.add(key);
      continue;
    }
    throw new Error('unsupported attempt status');
  }
  if (unresolved.length) return { action: 'pending', status: 'waiting_stt', unresolvedLogicalJobKeys: unresolved };
  const resolved = streams.filter((stream) => available.has(`${request.requestKey}:${stream.role}:${stream.liveStreamID}:${stream.mode}`));
  const allFailed = resolved.length === 0 && expected.length === streams.length
    && expected.length > 0 && hardFailed.size === expected.length;
  const coverageStatus = allFailed ? 'all_failed' : resolved.length === streams.length ? 'complete' : 'partial';
  return {
    action: allFailed ? 'all_failed' : 'ready',
    coverageStatus,
    availableRoles: resolved.map((stream) => stream.role),
    missingRoles: streams.filter((stream) => !resolved.includes(stream)).map((stream) => stream.role),
    failedLogicalJobKeys: failed,
    streams: streams.map((stream) => ({
      ...stream,
      dialogue: available.get(`${request.requestKey}:${stream.role}:${stream.liveStreamID}:${stream.mode}`)?.dialogue || '',
    })),
  };
}

function parseOrderedStreams(request) {
  let streams;
  try {
    streams = JSON.parse(request.orderedStreamsJson);
  } catch {
    throw new Error('Invalid orderedStreamsJson');
  }
  if (!Array.isArray(streams) || streams.length === 0) throw new Error('Invalid ordered streams');
  const roles = new Set();
  for (const stream of streams) {
    if (!stream || typeof stream !== 'object' || Array.isArray(stream)) throw new Error('Invalid ordered stream');
    for (const field of ['role', 'liveStreamID', 'mode']) {
      if (typeof stream[field] !== 'string' || stream[field].trim() === '') throw new Error(`Invalid ordered stream ${field}`);
    }
    if (roles.has(stream.role)) throw new Error('Ordered stream roles must be unique');
    roles.add(stream.role);
    if (!['fromStart', 'fromEnd'].includes(stream.mode)) throw new Error('Invalid ordered stream mode');
    if (!/^\d+$/.test(stream.liveStreamID)) throw new Error('Invalid ordered stream liveStreamID');
    if (typeof stream.durationMinutes !== 'number' || !Number.isFinite(stream.durationMinutes) || stream.durationMinutes <= 0) {
      throw new Error('Invalid ordered stream duration');
    }
    if (Object.hasOwn(stream, 'sttEligible') && typeof stream.sttEligible !== 'boolean') throw new Error('Invalid ordered stream sttEligible');
    const context = stream.streamContext;
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('Invalid stream context');
    if (context.liveStreamID !== stream.liveStreamID || typeof context.eligible !== 'boolean') throw new Error('Invalid resolved stream context');
    if (stream.sttEligible !== false) {
      if (context.eligible !== true) throw new Error('Resolved stream context is not eligible');
      for (const field of ['beginTime', 'endTime']) {
        if (typeof context[field] !== 'number' || !Number.isFinite(context[field])) throw new Error('Invalid stream context time');
      }
      if (context.endTime < context.beginTime) throw new Error('Invalid stream context range');
    }
  }
  return streams;
}

function parseExistingDialogues(request) {
  let value;
  try {
    value = JSON.parse(request.existingDialoguesJson);
  } catch {
    throw new Error('Invalid existingDialoguesJson');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid existing dialogues');
  for (const [role, dialogue] of Object.entries(value)) {
    if (!dialogue || typeof dialogue !== 'object' || Array.isArray(dialogue) || typeof dialogue.dialogue !== 'string' || !dialogue.dialogue.trim()) {
      throw new Error('Invalid existing dialogue');
    }
  }
  return value;
}

function parseExpectedLogicalJobKeys(request, streams, existing) {
  let expectedKeys;
  try {
    expectedKeys = JSON.parse(request.expectedLogicalJobKeysJson);
  } catch {
    throw new Error('Invalid expectedLogicalJobKeysJson');
  }
  if (!Array.isArray(expectedKeys)) throw new Error('Invalid expectedLogicalJobKeysJson');
  const computed = streams
    .filter((stream) => stream.sttEligible !== false && !existing[stream.role])
    .map((stream) => `${request.requestKey}:${stream.role}:${stream.liveStreamID}:${stream.mode}`);
  if (computed.length !== expectedKeys.length || new Set(expectedKeys).size !== expectedKeys.length
    || computed.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('Immutable expected keys mismatch');
  }
  return expectedKeys;
}

function planCreationRepair(request, attempts = [], nowIso = new Date().toISOString()) {
  validateRequestRow(request);
  strictIso(nowIso, 'current time');
  if (request.status !== 'creating') return { action: 'noop', repairClass: 'creation_lease', reason: 'request_already_accepted' };
  if (!ALLOWED_CHANNELS.has(request.channel)) throw new Error('Invalid request channel');
  if (!/^\d{10,}\.\d{6}$/.test(request.threadTS)) throw new Error('Invalid request threadTS');
  const owner = request.creationLeaseOwner || '';
  const until = request.creationLeaseUntilIso || '';
  const untilParsed = until === '' ? Number.NEGATIVE_INFINITY : Date.parse(until);
  if (until !== '' && !Number.isFinite(untilParsed)) throw new Error('Invalid creation lease expiry');
  if (owner !== '' && untilParsed > Date.parse(nowIso)) return { action: 'noop', repairClass: 'creation_lease', reason: 'creation_lease_active' };
  const orderedStreams = parseOrderedStreams(request);
  const existingDialogues = parseExistingDialogues(request);
  parseExpectedLogicalJobKeys(request, orderedStreams, existingDialogues);
  if (Array.isArray(attempts) && attempts.length > 0) {
    for (const att of attempts) {
      if (att && att.id) {
        validateAttemptRow(att);
        if (att.requestKey !== request.requestKey) throw new Error('Attempt requestKey mismatch');
      }
    }
  }
  return {
    action: 'resume_creation',
    repairClass: 'creation_lease',
    targetWorkflow: 'SummaryOrchV3A01',
    requiresPreflight: true,
    input: {
      requestKey: request.requestKey,
      requestType: request.requestType,
      orderedStreams,
      existingDialogues,
      channel: request.channel,
      threadTS: request.threadTS,
    },
  };
}

function planRequestReconciliation(rows, requestKey, summaryRows = []) {
  if (!nonempty(requestKey) || !Array.isArray(rows) || rows.length === 0) {
    throw new Error('Request rows not found');
  }
  validateRequestRows(rows, requestKey);
  return planSameKeyReconciliation(rows, 'request', summaryRows);
}

function planSameKeyReconciliation(rows, kind, summaryRows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return { action: 'ready', winnerRowID: '', mutations: [] };
  const validate = kind === 'request' ? validateRequestRow : validateAttemptRow;
  rows.forEach(validate);
  const keyField = kind === 'request' ? 'requestKey' : 'attemptKey';
  const key = rows[0][keyField];
  if (rows.some((row) => row[keyField] !== key)) throw new Error('Invalid same-key row set');
  if (kind === 'request') {
    for (const row of rows) {
      for (const field of REQUEST_IMMUTABLE_FIELDS) {
        if (row[field] !== rows[0][field]) throw new Error(`Immutable request payload conflict: ${field}`);
      }
    }
  } else {
    for (const row of rows) immutableAttemptMatches(row, rows[0]);
  }
  const summaries = meaningfulRows(summaryRows);
  for (const summary of summaries) {
    if (summary.requestKey !== rows[0].requestKey) throw new Error('Summary request key mismatch');
  }
  const canonicals = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  const checkpointFields = kind === 'request' ? SUMMARY_CHECKPOINT_FIELDS : ATTEMPT_CHECKPOINT_FIELDS;
  if (canonicals.length > 1) {
    const checkpointed = rows.some((row) => hasCheckpoint(row, checkpointFields))
      || (kind === 'attempt' && summaries.some((row) => hasCheckpoint(row, SUMMARY_CHECKPOINT_FIELDS)));
    if (checkpointed) {
      if (kind === 'request') {
        for (const row of canonicals) {
          if (!REQUEST_STAGES.has(row.status)) throw new Error('Checkpoint conflict has invalid original stage');
        }
      }
      return {
        action: 'manual_review',
        kind,
        reason: 'multiple_canonical_checkpoint_conflict',
        mutations: canonicals.map((row) => ({
          id: row.id,
          expectedStatus: row.status,
          expectedReconciliationStatus: 'canonical',
          expectedCanonicalRowID: String(row.id),
          desiredStatus: 'manual_review',
          desiredReconciliationStatus: 'canonical',
          ...(kind === 'request' ? { requestKey: row.requestKey, manualReviewOriginalStage: row.status } : { attemptKey: row.attemptKey }),
        })),
      };
    }
    const [winner, ...losers] = [...canonicals].sort(compareRows);
    return {
      action: 'reconcile',
      winnerRowID: winner.id,
      kind,
      mutations: losers.map((row) => ({
        id: row.id,
        expectedStatus: row.status,
        expectedReconciliationStatus: 'canonical',
        expectedCanonicalRowID: String(row.id),
        desiredReconciliationStatus: 'duplicate',
        desiredCanonicalRowID: String(winner.id),
        ...(kind === 'request' ? { requestKey: row.requestKey } : { attemptKey: row.attemptKey }),
      })),
    };
  }
  if (canonicals.length === 1) {
    const canonical = canonicals[0];
    const mutations = rows
      .filter((row) => row.id !== canonical.id)
      .filter((row) => row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(canonical.id))
      .map((row) => ({
        id: row.id,
        expectedStatus: row.status,
        expectedReconciliationStatus: row.reconciliationStatus,
        expectedCanonicalRowID: row.canonicalRowID || '',
        desiredReconciliationStatus: 'duplicate',
        desiredCanonicalRowID: String(canonical.id),
        ...(kind === 'request' ? { requestKey: row.requestKey } : { attemptKey: row.attemptKey }),
      }));
    return mutations.length
      ? { action: 'reconcile', winnerRowID: canonical.id, kind, mutations }
      : { action: 'ready', winnerRowID: canonical.id, canonical, kind, mutations: [] };
  }
  const [winner] = [...rows].sort(compareRows);
  return {
    action: 'reconcile',
    winnerRowID: winner.id,
    kind,
    mutations: rows.map((row) => ({
      id: row.id,
      expectedStatus: row.status,
      expectedReconciliationStatus: row.reconciliationStatus,
      expectedCanonicalRowID: row.canonicalRowID || '',
      desiredReconciliationStatus: row.id === winner.id ? 'canonical' : 'duplicate',
      desiredCanonicalRowID: String(winner.id),
      ...(kind === 'request' ? { requestKey: row.requestKey } : { attemptKey: row.attemptKey }),
    })),
  };
}

function verifySameKeyReconciliation(rows, plan, kind = 'attempt') {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Same key rows not found');
  const validate = kind === 'request' ? validateRequestRow : validateAttemptRow;
  rows.forEach(validate);
  const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
  if (plan?.action === 'manual_review') {
    const expectedIDs = (plan.mutations || []).map(({ id }) => id);
    if (canonicals.length !== expectedIDs.length) throw new Error('Checkpoint freeze is incomplete');
    for (const row of canonicals) {
      if (!expectedIDs.includes(row.id) || row.status !== 'manual_review' || row.manualReviewReason !== 'multiple_canonical_checkpoint_conflict') {
        throw new Error('Checkpoint freeze mismatch');
      }
    }
    return { action: 'verified_frozen' };
  }
  if (canonicals.length !== 1) throw new Error('Reconciliation requires exactly one canonical');
  const canonical = canonicals[0];
  if (plan?.winnerRowID && canonical.id !== plan.winnerRowID) throw new Error('Reconciliation winner mismatch');
  if (rows.some((row) => row.id !== canonical.id && (row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(canonical.id)))) {
    throw new Error('Reconciliation loser linkage mismatch');
  }
  return { action: 'verified', canonical };
}

function applyRepairCap(classPlans, repairClass, capErrors, nowIso) {
  if (classPlans.length <= REPAIR_CLASS_CAP) return classPlans;
  capErrors.push({
    action: 'cap_error',
    repairClass,
    code: 'repair_scan_cap_exceeded',
    count: classPlans.length,
    cap: REPAIR_CLASS_CAP,
    messageMasked: maskText(`repair ${repairClass} scan exceeded cap ${REPAIR_CLASS_CAP}; class stopped`),
    createdAtIso: nowIso,
  });
  return classPlans.slice(0, REPAIR_CLASS_CAP);
}

function planExpiredDispatchLease(row, nowIso = new Date().toISOString()) {
  validateAttemptRow(row);
  strictIso(nowIso, 'current time');
  if (row.status !== 'dispatching') throw new Error('Expired dispatch lease requires dispatching');
  if (!nonempty(row.dispatchLeaseOwner) || !nonempty(row.dispatchLeaseUntilIso)
    || strictIso(row.dispatchLeaseUntilIso, 'dispatch lease expiry') > strictIso(nowIso, 'current time')) {
    throw new Error('Dispatch lease is not expired');
  }
  return {
    action: 'manual_review',
    repairClass: 'expired_dispatch_lease',
    reason: 'dispatch_lease_expired_outcome_unknown',
    filters: {
      id: row.id,
      attemptKey: row.attemptKey,
      status: 'dispatching',
      reconciliationStatus: 'canonical',
      canonicalRowID: String(row.id),
      dispatchLeaseOwner: row.dispatchLeaseOwner || '',
      dispatchLeaseUntilIso: row.dispatchLeaseUntilIso,
    },
    desired: {
      status: 'manual_review',
      manualReviewReason: 'dispatch_lease_expired_outcome_unknown',
      manualReviewAtIso: nowIso,
      dispatchLeaseOwner: '',
      dispatchLeaseUntilIso: '',
      updatedAtIso: nowIso,
    },
    neverAutoResend: true,
  };
}

function planCallbackDeadline(row, nowIso = new Date().toISOString(), requestRow) {
  validateAttemptRow(row);
  strictIso(nowIso, 'current time');
  if (row.status !== 'waiting_callback') throw new Error('Callback deadline requires waiting_callback');
  if (!nonempty(row.callbackDeadlineAtIso) || strictIso(row.callbackDeadlineAtIso, 'callback deadline') > strictIso(nowIso, 'current time')) {
    throw new Error('Callback deadline is not due');
  }
  const timingSource = row.requestType === 'standalone_stt' ? row : requestRow;
  if (!timingSource || timingSource.requestKey !== row.requestKey) throw new Error('Callback deadline requires canonical request');
  if (timingSource !== row) validateRequestRow(timingSource);
  const failure = classifyAttemptFailure({ deadlineExceeded: true }, row.attempt, nowIso, timingSource.createdAt, timingSource.requestType);
  return {
    action: failure.classification,
    repairClass: 'callback_deadline',
    classification: failure.classification,
    status: failure.status,
    errorCode: failure.errorCode,
    nextRetryAtIso: failure.nextRetryAtIso || '',
    filters: {
      id: row.id,
      attemptKey: row.attemptKey,
      status: 'waiting_callback',
      reconciliationStatus: 'canonical',
      canonicalRowID: String(row.id),
      callbackDeadlineAtIso: row.callbackDeadlineAtIso,
    },
    desired: {
      status: failure.status,
      errorCode: failure.errorCode,
      nextRetryAtIso: failure.nextRetryAtIso || '',
      updatedAtIso: nowIso,
    },
  };
}

function planSummaryLease(row, nowIso = new Date().toISOString(), attemptRows = []) {
  validateRequestRow(row);
  strictIso(nowIso, 'current time');
  if (row.status === 'waiting_stt') {
    if (Array.isArray(attemptRows) && attemptRows.length > 0) {
      const result = aggregateLogicalJobs(row, attemptRows);
      if (result.action === 'ready' || result.action === 'all_failed') {
        return { ...planMissedEvent('coordinator_waiting_stt', row, {}, nowIso), repairClass: 'summary_lease' };
      }
      return { action: 'noop', repairClass: 'summary_lease', reason: 'waiting_stt_not_terminal' };
    }
    const existing = parseExistingDialogues(row);
    const streams = parseOrderedStreams(row);
    if (streams.every((stream) => existing[stream.role])) {
      return { ...planMissedEvent('coordinator_waiting_stt', row, {}, nowIso), repairClass: 'summary_lease' };
    }
    return { ...planMissedEvent('coordinator_waiting_stt', row, {}, nowIso), repairClass: 'summary_lease' };
  }
  if (row.status === 'ready') {
    const owner = row.leaseOwner || '';
    const until = row.leaseUntilIso || '';
    if (owner !== '' && isDueOrExpired(until, nowIso, 'summary lease expiry') === false) {
      return { action: 'noop', repairClass: 'summary_lease', reason: 'summary_lease_active' };
    }
    return { ...planMissedEvent('coordinator_ready', row, {}, nowIso), repairClass: 'summary_lease' };
  }
  if (row.status === 'summary_retry_pending') {
    const owner = row.leaseOwner || '';
    const until = row.leaseUntilIso || '';
    if (owner !== '' || until !== '') {
      throw new Error('Summary retry pending lease pair is malformed');
    }
    if (nonempty(row.nextRetryAtIso) && Date.parse(row.nextRetryAtIso) <= Date.parse(nowIso)) {
      return {
        action: 'call_coordinator',
        repairClass: 'summary_lease',
        targetWorkflow: 'SummaryCoordV3A1',
        input: { requestKey: row.requestKey },
        requiresPreflight: true,
      };
    }
    return { action: 'noop', repairClass: 'summary_lease', reason: 'summary_retry_not_due' };
  }
  if (row.status === 'summary_dispatching') {
    if (!nonempty(row.leaseOwner) || !nonempty(row.leaseUntilIso)) {
      throw new Error('Summary dispatching lease pair is malformed');
    }
    if (Date.parse(row.leaseUntilIso) <= Date.parse(nowIso)) {
      return { ...planMissedEvent('coordinator_summary_expired', row, {}, nowIso), repairClass: 'summary_lease' };
    }
    return { action: 'noop', repairClass: 'summary_lease', reason: 'summary_lease_active' };
  }
  return { action: 'noop', repairClass: 'summary_lease', reason: 'summary_not_repairable' };
}

function planPresentationLease(attempt, nowIso = new Date().toISOString()) {
  if (!['completed', 'failed', 'timed_out'].includes(attempt.status)) return { action: 'noop', repairClass: 'presentation_lease', reason: 'presentation_not_terminal' };
  if (attempt.presentationStatus === 'retry_pending' && nonempty(attempt.presentationNextRetryAtIso) && Date.parse(attempt.presentationNextRetryAtIso) <= Date.parse(nowIso)) {
    return planPresentationRepair(attempt, nowIso);
  }
  if (attempt.presentationStatus === 'presenting' && nonempty(attempt.presentationLeaseUntilIso) && Date.parse(attempt.presentationLeaseUntilIso) <= Date.parse(nowIso)) {
    return planPresentationRepair(attempt, nowIso);
  }
  return { action: 'noop', repairClass: 'presentation_lease', reason: 'presentation_not_repairable' };
}

function isAutomaticCandidate(row) {
  return row.status !== 'manual_review';
}

function isDueOrExpired(value, nowIso, field) {
  try {
    return nonempty(value) && strictIso(value, field) <= strictIso(nowIso, 'current time');
  } catch {
    return false;
  }
}

function repairLocator(row, kind) {
  const locator = {
    id: row.id,
    createdAt: row.createdAt,
    status: row.status,
    reconciliationStatus: row.reconciliationStatus,
    canonicalRowID: row.canonicalRowID,
  };
  if (kind === 'attempt') {
    locator.attemptKey = row.attemptKey;
    locator.dispatchLeaseOwner = row.dispatchLeaseOwner;
    locator.dispatchLeaseUntilIso = row.dispatchLeaseUntilIso;
    locator.callbackDeadlineAtIso = row.callbackDeadlineAtIso;
    locator.nextRetryAtIso = row.nextRetryAtIso;
    locator.retryLeaseOwner = row.retryLeaseOwner;
    locator.retryLeaseUntilIso = row.retryLeaseUntilIso;
    locator.presentationStatus = row.presentationStatus;
    locator.presentationLeaseUntilIso = row.presentationLeaseUntilIso;
    locator.presentationNextRetryAtIso = row.presentationNextRetryAtIso;
  } else {
    locator.requestKey = row.requestKey;
    locator.creationLeaseUntilIso = row.creationLeaseUntilIso;
    locator.leaseUntilIso = row.leaseUntilIso;
    locator.nextRetryAtIso = row.nextRetryAtIso;
  }
  return locator;
}

function planRepairCapError(repairClass, count, nowIso) {
  strictIso(nowIso, 'current time');
  const component = 'automation_retry_and_repair_v3';
  const errorCode = 'repair_scan_cap_exceeded';
  const messageMasked = maskText(`repair class=${repairClass} eligible=${count} cap=${REPAIR_CLASS_CAP}; class stopped`);
  const errorKey = `err:v1:${fnv1a([component, repairClass, errorCode, String(count), nowIso].join('|'))}`;
  return {
    kind: 'cap_error',
    errorKey,
    component,
    reconciliationStatus: 'pending',
    canonicalRowID: '',
    requestKey: '',
    logicalJobKey: '',
    attemptKey: '',
    executionID: '',
    workflowName: 'Automation: retry and repair v3',
    nodeName: `Plan Bounded ${repairClass}`,
    errorCode,
    messageMasked,
    retryable: false,
    createdAtIso: nowIso,
    repairClass,
    count,
    cap: REPAIR_CLASS_CAP,
  };
}

function planBoundedClass(repairClass, rows, nowIso = new Date().toISOString()) {
  strictIso(nowIso, 'current time');
  if (!REPAIR_CLASS_ORDER.includes(repairClass)) throw new Error('Unknown repair class');
  if (!Array.isArray(rows)) throw new Error('Bounded rows must be an array');
  const candidates = [];
  for (const raw of rows) {
    try {
      if (!raw || !raw.id || raw.status === 'manual_review' || nonempty(raw.manualReviewAtIso) || nonempty(raw.manualReviewReason)) continue;
      if (repairClass === 'duplicate_deterministic_keys') {
        if (Object.hasOwn(raw, 'attemptKey')) validateAttemptRow(raw);
        else validateRequestRow(raw);
      } else if (['expired_dispatch_lease', 'callback_deadline', 'retry_materialization', 'presentation_lease'].includes(repairClass)) {
        validateAttemptRow(raw);
      } else {
        validateRequestRow(raw);
      }
      if (repairClass !== 'duplicate_deterministic_keys') {
        if (raw.reconciliationStatus !== 'canonical' || raw.canonicalRowID !== String(raw.id)) continue;
      } else {
        if (raw.reconciliationStatus === 'canonical') {
          if (raw.canonicalRowID !== String(raw.id)) continue;
        } else if (raw.reconciliationStatus === 'pending') {
          if (raw.canonicalRowID !== '') continue;
        } else {
          continue;
        }
      }
      let eligible = false;
      if (repairClass === 'expired_dispatch_lease') {
        eligible = raw.status === 'dispatching' && nonempty(raw.dispatchLeaseOwner)
          && isDueOrExpired(raw.dispatchLeaseUntilIso, nowIso, 'dispatch lease expiry');
      } else if (repairClass === 'callback_deadline') {
        eligible = raw.status === 'waiting_callback'
          && isDueOrExpired(raw.callbackDeadlineAtIso, nowIso, 'callback deadline');
      } else if (repairClass === 'retry_materialization') {
        eligible = (raw.status === 'retry_pending' && raw.retryLeaseOwner === '' && raw.retryLeaseUntilIso === ''
          && isDueOrExpired(raw.nextRetryAtIso, nowIso, 'retry due time'))
          || (raw.status === 'retry_materializing' && nonempty(raw.retryLeaseOwner)
            && isDueOrExpired(raw.retryLeaseUntilIso, nowIso, 'retry lease expiry'));
      } else if (repairClass === 'creation_lease') {
        eligible = raw.status === 'creating' && (!nonempty(raw.creationLeaseOwner)
          || isDueOrExpired(raw.creationLeaseUntilIso, nowIso, 'creation lease expiry'));
      } else if (repairClass === 'summary_lease') {
        eligible = raw.status === 'waiting_stt'
          || (raw.status === 'ready' && (!nonempty(raw.leaseOwner) || isDueOrExpired(raw.leaseUntilIso, nowIso, 'summary lease expiry')))
          || (raw.status === 'summary_retry_pending' && isDueOrExpired(raw.nextRetryAtIso, nowIso, 'summary retry due time'))
          || (raw.status === 'summary_dispatching' && nonempty(raw.leaseOwner)
            && isDueOrExpired(raw.leaseUntilIso, nowIso, 'summary lease expiry'));
      } else if (repairClass === 'presentation_lease') {
        const pAttempt = Number(raw.presentationAttempt || 0);
        eligible = ['completed', 'failed', 'timed_out'].includes(raw.status) && Number.isInteger(pAttempt) && pAttempt >= 0 && pAttempt < 3 && ((raw.presentationStatus === 'retry_pending'
          && raw.presentationLeaseOwner === '' && raw.presentationLeaseUntilIso === ''
          && isDueOrExpired(raw.presentationNextRetryAtIso, nowIso, 'presentation retry due time'))
          || (raw.presentationStatus === 'presenting' && nonempty(raw.presentationLeaseOwner)
            && isDueOrExpired(raw.presentationLeaseUntilIso, nowIso, 'presentation lease expiry')));
      } else if (repairClass === 'duplicate_deterministic_keys') {
        eligible = raw.reconciliationStatus === 'pending' || (raw.reconciliationStatus === 'canonical' && raw.canonicalRowID === String(raw.id));
      }
      if (eligible) candidates.push(raw);
    } catch {
      // Malformed rows are intentionally not eligible for automatic repair.
    }
  }
  candidates.sort(compareRows);
  const bounded = candidates.slice(0, REPAIR_CLASS_CAP).map((row) => {
    const isRequest = ['creation_lease', 'summary_lease'].includes(repairClass) || !Object.hasOwn(row, 'attemptKey');
    const locator = repairLocator(row, isRequest ? 'request' : 'attempt');
    return {
      kind: 'candidate',
      repairClass,
      nowIso,
      id: row.id,
      ...(row.attemptKey ? { attemptKey: row.attemptKey } : {}),
      ...(row.requestKey ? { requestKey: row.requestKey } : {}),
      status: row.status,
      reconciliationStatus: row.reconciliationStatus,
      canonicalRowID: row.canonicalRowID,
      __repairGroupKey: locator,
      locator,
    };
  });
  return candidates.length > REPAIR_CLASS_CAP
    ? [...bounded, planRepairCapError(repairClass, candidates.length, nowIso)]
    : bounded;
}

function planCapErrorRows(rows, candidate) {
  if (!candidate || typeof candidate !== 'object') throw new Error('Cap error candidate is required');
  const immutable = ['errorKey', 'component', 'requestKey', 'logicalJobKey', 'attemptKey', 'executionID', 'workflowName', 'nodeName', 'errorCode', 'messageMasked', 'retryable'];
  const compare = (a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id;
  for (const row of rows) {
    if (!Number.isInteger(row.id) || row.id <= 0 || !row.createdAt || !['pending', 'canonical', 'duplicate'].includes(row.reconciliationStatus)) throw new Error('invalid error reconciliation system fields');
    if ((row.reconciliationStatus === 'canonical' && row.canonicalRowID !== String(row.id)) || (row.reconciliationStatus === 'pending' && row.canonicalRowID) || (row.reconciliationStatus === 'duplicate' && !row.canonicalRowID)) throw new Error('invalid error reconciliation linkage');
    if (immutable.some((key) => String(row[key] ?? '') !== String(candidate[key] ?? ''))) throw new Error('immutable masked error payload drift');
  }
  if (rows.length === 0) return [{ ...candidate, action: 'insert_pending', __planCarrier: true }];
  const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical');
  const winner = canonicals.length === 1 ? canonicals[0] : [...(canonicals.length ? canonicals : rows)].sort(compare)[0];
  const mutations = rows.filter((row) => row.id === winner.id ? row.reconciliationStatus !== 'canonical' || row.canonicalRowID !== String(row.id) : row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(winner.id)).map((row) => ({ ...candidate, action: 'reconcile', id: row.id, expectedReconciliationStatus: row.reconciliationStatus, expectedCanonicalRowID: row.canonicalRowID || '', desiredReconciliationStatus: row.id === winner.id ? 'canonical' : 'duplicate', desiredCanonicalRowID: String(row.id === winner.id ? row.id : winner.id), canonicalRowID: String(winner.id), __planCarrier: true }));
  return mutations.length ? mutations : [{ ...candidate, action: 'insert_duplicate', canonicalRowID: String(winner.id), __planCarrier: true }];
}

function planPendingCapErrorCanonical(rows) {
  const validRows = (rows || []).filter((row) => row && row.id);
  if (!validRows.length) throw new Error('pending error insert was not found');
  const compare = (a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id;
  const canonical = validRows.filter((row) => row.reconciliationStatus === 'canonical');
  const winner = canonical.length === 1 ? canonical[0] : [...(canonical.length ? canonical : validRows)].sort(compare)[0];
  return validRows.map((row) => ({
    id: row.id,
    errorKey: row.errorKey,
    expectedReconciliationStatus: row.reconciliationStatus,
    expectedCanonicalRowID: row.canonicalRowID || '',
    desiredReconciliationStatus: row.id === winner.id ? 'canonical' : 'duplicate',
    desiredCanonicalRowID: String(row.id === winner.id ? row.id : winner.id),
  }));
}

function verifyCapErrorReconciliation(rows) {
  const validRows = (rows || []).filter((row) => row && row.id);
  const canonical = validRows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonical.length !== 1 || canonical[0].canonicalRowID !== String(canonical[0].id) || validRows.some((row) => row.reconciliationStatus !== 'canonical' && (row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(canonical[0].id)))) {
    throw new Error('error reconciliation verification failed');
  }
  return [{ canonicalRowID: String(canonical[0].id) }];
}

function verifyDuplicateCapError(rows) {
  const validRows = (rows || []).filter((row) => row && row.id);
  const canonical = validRows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonical.length !== 1 || canonical[0].canonicalRowID !== String(canonical[0].id) || validRows.some((row) => row.reconciliationStatus !== 'canonical' && (row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(canonical[0].id)))) {
    throw new Error('duplicate error verification failed');
  }
  return [{ errorKey: canonical[0].errorKey, canonicalRowID: String(canonical[0].id) }];
}

function sortGroups(groups) {
  return [...groups].sort((left, right) => compareRows([...left].sort(compareRows)[0], [...right].sort(compareRows)[0]));
}

function repairGroupKey(row, fallbackKind) {
  if (nonempty(row?.__repairGroupKey)) return row.__repairGroupKey;
  if (fallbackKind === 'request' || (!row?.attemptKey && nonempty(row?.requestKey))) return `request:${row.requestKey}`;
  if (nonempty(row?.attemptKey)) return `attempt:${row.attemptKey}`;
  throw new Error('Repair context has no deterministic key');
}

function groupRepairContexts(items, fallbackKind) {
  const groups = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const key = repairGroupKey(item, fallbackKind);
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function dedupeSystemRows(rows) {
  const unique = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    const previous = unique.get(row.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error(`Conflicting duplicate system row ${row.id}`);
    unique.set(row.id, row);
  }
  return [...unique.values()];
}

function planRepairScan({ attemptRows = [], requestRows = [], nowIso, leaseOwner = 'repair' }) {
  strictIso(nowIso, 'current time');
  if (!Array.isArray(attemptRows) || !Array.isArray(requestRows)) throw new Error('Invalid repair scan input');
  const meaningfulAttempts = attemptRows.filter((row) => row && row.id);
  meaningfulAttempts.forEach(validateAttemptRow);
  const meaningfulRequests = requestRows.filter((row) => row && row.id);
  meaningfulRequests.forEach(validateRequestRow);
  const requestsByKey = new Map();
  for (const row of meaningfulRequests) {
    const list = requestsByKey.get(row.requestKey) || [];
    list.push(row);
    requestsByKey.set(row.requestKey, list);
  }
  const attemptsByKey = new Map();
  for (const row of meaningfulAttempts) {
    const list = attemptsByKey.get(row.attemptKey) || [];
    list.push(row);
    attemptsByKey.set(row.attemptKey, list);
  }
  const canonical = (rows) => rows.filter((row) => row.reconciliationStatus === 'canonical').sort(compareRows);
  const requestForAttempt = (row) => row.requestType === 'standalone_stt'
    ? undefined
    : canonicalRequest(requestsByKey.get(row.requestKey) || [], row.requestKey);
  const plans = [];
  const capErrors = [];

  let classPlans = canonical(meaningfulAttempts.filter((row) => (
    isAutomaticCandidate(row)
    && row.status === 'dispatching'
    && nonempty(row.dispatchLeaseUntilIso)
    && Date.parse(row.dispatchLeaseUntilIso) <= Date.parse(nowIso)
  ))).map((row) => planExpiredDispatchLease(row, nowIso));
  plans.push(...applyRepairCap(classPlans, 'expired_dispatch_lease', capErrors, nowIso));

  classPlans = canonical(meaningfulAttempts.filter((row) => (
    isAutomaticCandidate(row)
    && row.status === 'waiting_callback'
    && nonempty(row.callbackDeadlineAtIso)
    && Date.parse(row.callbackDeadlineAtIso) <= Date.parse(nowIso)
  ))).map((row) => planCallbackDeadline(row, nowIso, requestForAttempt(row)));
  plans.push(...applyRepairCap(classPlans, 'callback_deadline', capErrors, nowIso));

  classPlans = canonical(meaningfulAttempts.filter((row) => (
    isAutomaticCandidate(row)
    && ((row.status === 'retry_pending' && nonempty(row.nextRetryAtIso) && Date.parse(row.nextRetryAtIso) <= Date.parse(nowIso))
      || (row.status === 'retry_materializing' && nonempty(row.retryLeaseUntilIso) && Date.parse(row.retryLeaseUntilIso) <= Date.parse(nowIso)))
  ))).map((row) => planRetryMaterializationClaim(row, nowIso, leaseOwner, requestForAttempt(row))).filter((plan) => plan.action !== 'noop');
  plans.push(...applyRepairCap(classPlans, 'retry_materialization', capErrors, nowIso));

  classPlans = canonical(meaningfulRequests.filter((row) => row.status === 'creating'))
    .map((row) => planCreationRepair(row, attemptsByKey.get(row.requestKey) || [], nowIso))
    .filter((plan) => plan.action !== 'noop');
  plans.push(...applyRepairCap(classPlans, 'creation_lease', capErrors, nowIso));

  classPlans = canonical(meaningfulRequests.filter((row) => (
    ['waiting_stt', 'ready', 'summary_retry_pending', 'summary_dispatching'].includes(row.status)
  ))).map((row) => planSummaryLease(row, nowIso)).filter((plan) => plan.action !== 'noop');
  plans.push(...applyRepairCap(classPlans, 'summary_lease', capErrors, nowIso));

  classPlans = canonical(meaningfulAttempts.filter((row) => isAutomaticCandidate(row) && row.status === 'completed'))
    .map((row) => planPresentationLease(row, nowIso)).filter((plan) => plan.action !== 'noop');
  plans.push(...applyRepairCap(classPlans, 'presentation_lease', capErrors, nowIso));

  const duplicatePlans = [];
  for (const group of sortGroups([...attemptsByKey.values()])) {
    const summaries = requestsByKey.get(group[0].requestKey) || [];
    const plan = planSameKeyReconciliation(group, 'attempt', summaries);
    if (plan.action !== 'ready') duplicatePlans.push({ ...plan, repairClass: 'duplicate_deterministic_keys' });
  }
  for (const group of sortGroups([...requestsByKey.values()])) {
    const plan = planSameKeyReconciliation(group, 'request', []);
    if (plan.action !== 'ready') duplicatePlans.push({ ...plan, repairClass: 'duplicate_deterministic_keys' });
  }
  plans.push(...applyRepairCap(duplicatePlans, 'duplicate_deterministic_keys', capErrors, nowIso));

  return { plans, capErrors };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ATTEMPT_CHECKPOINT_FIELDS,
    ATTEMPT_FIELDS,
    ATTEMPT_IMMUTABLE_FIELDS,
    CHANNEL,
    MAX_AUTOMATIC_ATTEMPTS,
    REPAIR_CLASS_CAP,
    REPAIR_CLASS_ORDER,
    REQUEST_CHECKPOINT_FIELDS: SUMMARY_CHECKPOINT_FIELDS,
    REQUEST_FIELDS,
    REQUEST_IMMUTABLE_FIELDS,
    REQUEST_STAGES,
    RESOLUTION_EPOCH_ISO,
    RETRYABLE_HTTP_STATUSES,
    SCHEMA_KEYS,
    SUMMARY_CHECKPOINT_FIELDS,
    STT_RETRY_DEADLINE_MINUTES,
    STT_RETRY_SLOT_MINUTES,
    SUMMARY_STT_RETRY_DEADLINE_MINUTES,
    SUMMARY_STT_RETRY_SLOT_MINUTES,
    addMinutes,
    aggregateLogicalJobs,
    buildNextAttempt,
    canonicalRequest,
    classifyAttemptFailure,
    compareRows,
    dedupeSystemRows,
    groupRepairContexts,
    hasCheckpoint,
    immutableAttemptMatches,
    isAutomaticCandidate,
    maskedAuditPlans,
    maskText,
    nextRetryDelayMs,
    nonempty,
    parseExistingDialogues,
    parseOrderedStreams,
    planAttemptFailurePatch,
    planAttemptManualResolution,
    planAutoRetryOldTransition,
    planBoundedClass,
    planCapErrorRows,
    planPendingCapErrorCanonical,
    planRepairCapError,
    planCallbackDeadline,
    planCreationRepair,
    planExpiredDispatchLease,
    planManualRetryOldTransition,
    planMissedEvent,
    planNextAttemptReconciliation,
    planOldTransitionVerify: verifyOldTransition,
    planPresentationLease,
    planPresentationOwnerCall,
    planPresentationRepair,
    planRepairScan,
    planRequestReconciliation,
    planRequestResolution,
    planRetry,
    planRetryMaterializationClaim,
    planSameKeyReconciliation,
    planSummaryFailurePatch,
    planSummaryLease,
    repairGroupKey,
    runRequestResolution,
    strictIso,
    sttRetryDelayMs,
    sttRetryTiming,
    validateAttemptRow,
    validatePrimitive,
    validateRequestRow,
    validateRequestRows,
    verifyCapErrorReconciliation,
    verifyDuplicateCapError,
    verifyNextRows,
    verifyOldTransition,
    verifyPresentationRepair,
    verifySameKeyReconciliation,
  };
}

if (typeof $input !== 'undefined') {
  const allItems = $input.all().map(({ json }) => json);
  if (allItems.length === 0) return [];
  const modes = new Set(allItems.map((item) => item?.repairMode).filter(Boolean));
  if (modes.size !== 1 || allItems.some((item) => !item?.repairMode)) {
    throw new Error(`Plan Repairs requires a uniform repairMode across all input items, found: ${[...modes].join(', ')}`);
  }
  const mode = [...modes][0];
  if (mode.startsWith('bounded:')) {
    const repairClass = mode.slice('bounded:'.length);
    const nowValues = new Set(allItems.map((item) => item.nowIso).filter(Boolean));
    if (nowValues.size > 1) throw new Error('Bounded repair scan has inconsistent scan time');
    return planBoundedClass(repairClass, allItems, [...nowValues][0] || new Date().toISOString())
      .map((json) => ({ json }));
  }
  if (mode === 'actual:expired_dispatch') {
    const rows = allItems.filter((row) => row && row.id && row.attemptKey && row.kind !== 'candidate');
    const attemptKeys = [...new Set(rows.map((row) => row.attemptKey))];
    return attemptKeys.map((attemptKey) => {
      const matching = rows.filter((row) => row.attemptKey === attemptKey);
      const canonical = matching.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
      if (canonical.length !== 1) throw new Error(`Expired dispatch reread requires exactly one canonical attempt for ${attemptKey}`);
      const nowValues = new Set(matching.map((row) => row.nowIso));
      if (nowValues.size !== 1) throw new Error(`Expired dispatch reread has inconsistent scan time for ${attemptKey}`);
      return { json: { plan: planExpiredDispatchLease(canonical[0], matching[0].nowIso), attemptKey, __repairGroupKey: `attempt:${attemptKey}` } };
    });
  }
  if (mode === 'actual:callback_deadline') {
    const rows = allItems.filter((row) => row && row.id && row.attemptKey && row.kind !== 'candidate');
    const attemptKeys = [...new Set(rows.map((row) => row.attemptKey))];
    return attemptKeys.map((attemptKey) => {
      const matching = rows.filter((row) => row.attemptKey === attemptKey);
      const canonical = matching.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
      if (canonical.length !== 1) throw new Error(`Callback deadline reread requires exactly one canonical attempt for ${attemptKey}`);
      const nowValues = new Set(matching.map((row) => row.nowIso));
      if (nowValues.size !== 1) throw new Error(`Callback deadline reread has inconsistent scan time for ${attemptKey}`);
      const requests = dedupeSystemRows(allItems.filter((row) => row?.id && !row.attemptKey && row.requestKey === canonical[0].requestKey));
      const request = canonical[0].requestType === 'standalone_stt' ? undefined : canonicalRequest(requests, canonical[0].requestKey);
      return { json: { plan: planCallbackDeadline(canonical[0], matching[0].nowIso, request), attemptKey, __repairGroupKey: `attempt:${attemptKey}` } };
    });
  }
  if (mode === 'cap_error_rows') {
    const items = allItems;
    const candidate = items.find((row) => row && row.kind === 'cap_error' && row.errorKey) || items.find((row) => row && row.errorKey && !row.id);
    const rows = items.filter((row) => row && row.id && row.kind !== 'cap_error');
    if (!candidate) throw new Error('Cap error candidate was not found');
    const plan = planCapErrorRows(rows, candidate);
    return plan.map((json) => ({ json }));
  }
  if (mode === 'pending_cap_canonical') {
    const rows = allItems.filter((row) => row && row.id);
    return planPendingCapErrorCanonical(rows).map((json) => ({ json }));
  }
  if (mode === 'verify_cap_reconciliation') {
    const rows = allItems.filter((row) => row && row.id);
    return verifyCapErrorReconciliation(rows).map((json) => ({ json }));
  }
  if (mode === 'verify_duplicate_cap') {
    const rows = allItems.filter((row) => row && row.id);
    return verifyDuplicateCapError(rows).map((json) => ({ json }));
  }
  if (mode === 'scan') {
    const result = planRepairScan({
      attemptRows: allItems.filter((row) => row && row.id),
      requestRows: allItems.flatMap((item) => (item.requestRows || []).filter((row) => row && row.id)),
      nowIso: allItems.find((item) => item.nowIso)?.nowIso || new Date().toISOString(),
      leaseOwner: allItems.find((item) => item.leaseOwner)?.leaseOwner || (typeof $execution !== 'undefined' && $execution.id) || 'repair',
    });
    return [...result.plans, ...result.capErrors].map((json) => ({ json }));
  }
  if (mode === 'retry_claim') {
    const rows = dedupeSystemRows(allItems.filter((row) => row?.id && row.attemptKey));
    const owner = allItems.find((row) => row.leaseOwner)?.leaseOwner || (typeof $execution !== 'undefined' ? $execution.id : 'repair');
    return [...groupRepairContexts(rows, 'attempt').entries()].flatMap(([groupKey, group]) => {
      const canonical = group.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
      if (canonical.length !== 1) throw new Error(`Retry claim requires exactly one canonical attempt for ${groupKey}`);
      const requests = dedupeSystemRows(allItems.filter((row) => row?.id && !row.attemptKey && row.requestKey === canonical[0].requestKey));
      const request = canonical[0].requestType === 'standalone_stt' ? undefined : canonicalRequest(requests, canonical[0].requestKey);
      const plan = planRetryMaterializationClaim(canonical[0], canonical[0].nowIso || new Date().toISOString(), owner, request);
      return plan.action === 'claim' ? [{ json: { ...plan, oldAttempt: canonical[0], __repairGroupKey: groupKey, __planCarrier: true, __planPhase: 'retry-claim', repairMode: 'retry_verify_claim' } }] : [];
    });
  }
  if (mode === 'retry_verify_claim') {
    const carriers = allItems.filter((row) => row.__planCarrier && row.__planPhase === 'retry-claim');
    return carriers.map((plan) => {
      const rows = dedupeSystemRows(allItems.filter((row) => row?.id && row.attemptKey === plan.filters.attemptKey));
      const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
      if (canonical.length !== 1) throw new Error(`Retry claim reread requires exactly one canonical attempt for ${plan.__repairGroupKey}`);
      const row = canonical[0];
      if (row.id !== plan.filters.id || row.status !== 'retry_materializing' || row.retryLeaseOwner !== plan.leaseOwner || row.retryLeaseUntilIso !== plan.retryLeaseUntilIso || strictIso(row.retryLeaseUntilIso, 'retry lease expiry') <= strictIso(plan.oldAttempt.nowIso || new Date().toISOString(), 'current time')) throw new Error(`Retry claim owner was not verified for ${plan.__repairGroupKey}`);
      return { json: { ...plan, oldAttempt: row, __planCarrier: true, __planPhase: 'retry-verified-claim', repairMode: 'retry_plan_next' } };
    });
  }
  if (mode === 'retry_plan_next') {
    const carriers = allItems.filter((row) => row.__planCarrier && row.__planPhase === 'retry-verified-claim');
    return carriers.map((plan) => {
      const rows = dedupeSystemRows(allItems.filter((row) => row?.id && row.attemptKey === plan.nextAttemptKey));
      const expected = buildNextAttempt(plan.oldAttempt, plan.oldAttempt.nowIso || new Date().toISOString());
      const summaryRows = dedupeSystemRows(allItems.filter((row) => row?.id && !row.attemptKey && row.requestKey === plan.oldAttempt.requestKey));
      const nextPlan = planNextAttemptReconciliation(rows, expected, summaryRows);
      const phase = nextPlan.action === 'insert' ? 'retry-next-insert' : nextPlan.action === 'reconcile' ? 'retry-next-reconcile' : nextPlan.action === 'manual_review' ? 'retry-next-freeze' : 'retry-next-ready';
      return { json: { ...plan, expectedNext: expected, nextPlan, nextAction: nextPlan.action === 'manual_review' ? 'freeze' : nextPlan.action, __planCarrier: true, __planPhase: phase, repairMode: nextPlan.action === 'manual_review' ? 'retry_verify_freeze' : 'retry_verify_next' } };
    });
  }
  if (mode === 'retry_insert_carrier') {
    return allItems.filter((plan) => plan.__planPhase === 'retry-next-insert' && plan.nextPlan?.action === 'insert').map((plan) => ({ json: { ...plan.expectedNext, ...plan, __planCarrier: true, __planPhase: 'retry-next-insert', repairMode: 'retry_verify_next' } }));
  }
  if (mode === 'retry_mutation_carrier') {
    return allItems.filter((plan) => ['retry-next-reconcile', 'retry-next-freeze'].includes(plan.__planPhase)).flatMap((plan) => {
      const repairMode = plan.__planPhase === 'retry-next-freeze' ? 'retry_verify_freeze' : 'retry_verify_next';
      return (plan.nextPlan.mutations || []).map((mutation) => ({ json: { ...plan, mutation, __planCarrier: true, __planPhase: plan.__planPhase, repairMode } }));
    });
  }
  if (mode === 'retry_verify_next') {
    const plans = allItems.filter((row) => row.__planCarrier && row.nextPlan && ['retry-next-insert', 'retry-next-reconcile', 'retry-next-ready'].includes(row.__planPhase));
    return plans.flatMap((plan) => {
      const rows = dedupeSystemRows(allItems.filter((row) => row?.id && row.attemptKey === plan.nextAttemptKey));
      const verified = verifyNextRows(rows, plan.nextPlan);
      if (verified.action === 'verified_frozen') return [];
      if (verified.canonical.status !== 'queued') throw new Error(`Next retry attempt is not canonical queued for ${plan.__repairGroupKey}`);
      return [{ json: { ...plan, canonicalNext: verified.canonical, __planCarrier: true, __planPhase: 'retry-next-verified', repairMode: 'retry_plan_old_transition' } }];
    });
  }
  if (mode === 'retry_verify_freeze') {
    const plans = allItems.filter((row) => row.__planCarrier && row.nextPlan?.action === 'manual_review');
    for (const plan of plans) verifyNextRows(dedupeSystemRows(allItems.filter((row) => row?.id && row.attemptKey === plan.nextAttemptKey)), plan.nextPlan);
    return [];
  }
  if (mode === 'retry_plan_old_transition') {
    return allItems.filter((plan) => plan.__planCarrier && plan.canonicalNext && plan.__planPhase === 'retry-next-verified').map((plan) => {
      if (plan.canonicalNext.attemptKey !== plan.nextAttemptKey || plan.canonicalNext.status !== 'queued') throw new Error(`Verified next retry canonical is missing for ${plan.__repairGroupKey}`);
      const transition = planAutoRetryOldTransition(plan.oldAttempt, plan.nextAttemptKey, plan.oldAttempt.nowIso || new Date().toISOString());
      return { json: { ...plan, transition, __planCarrier: true, __planPhase: 'retry-old-transition', repairMode: 'retry_verify_old' } };
    });
  }
  if (mode === 'retry_verify_old') {
    return allItems.filter((plan) => plan.__planCarrier && plan.transition && plan.__planPhase === 'retry-old-transition').map((plan) => {
      verifyOldTransition(dedupeSystemRows(allItems.filter((row) => row?.id && row.attemptKey === plan.transition.filters.attemptKey)), plan.transition);
      const next = verifyNextRows(dedupeSystemRows(allItems.filter((row) => row?.id && row.attemptKey === plan.nextAttemptKey)), { action: 'ready', winnerRowID: plan.canonicalNext.id });
      if (next.canonical.status !== 'queued') throw new Error(`Next retry attempt is not queued after old transition for ${plan.__repairGroupKey}`);
      return { json: { attemptKey: plan.nextAttemptKey, __repairGroupKey: plan.__repairGroupKey } };
    });
  }
  if (mode === 'retry_dispatch_preflight') {
    const rows = allItems.filter((row) => row && row.id && row.attemptKey);
    const next = verifyNextRows(rows, { action: 'ready' }).canonical;
    if (next.status !== 'queued' || next.dispatchLeaseOwner !== '' || next.dispatchLeaseUntilIso !== '') throw new Error('Retry dispatch preflight failed');
    return [{ json: { attemptKey: next.attemptKey } }];
  }
  if (mode === 'creation_preflight') {
    const requestRows = dedupeSystemRows(allItems.filter((row) => row?.id && row.requestKey && !row.attemptKey));
    return [...groupRepairContexts(requestRows, 'request').entries()].flatMap(([groupKey, rows]) => {
      const reqReconcile = planRequestReconciliation(rows, rows[0].requestKey);
      if (reqReconcile.action !== 'ready' || reqReconcile.canonical.status !== 'creating') return [];
      const attempts = dedupeSystemRows(allItems.filter((row) => row?.id && row.attemptKey && row.requestKey === reqReconcile.canonical.requestKey));
      const plan = planCreationRepair(reqReconcile.canonical, attempts, reqReconcile.canonical.nowIso || new Date().toISOString());
      return plan.action === 'resume_creation' ? [{ json: { ...plan.input, __repairGroupKey: groupKey } }] : [];
    });
  }
  if (mode === 'summary_preflight') {
    const requestRows = dedupeSystemRows(allItems.filter((row) => row?.id && row.requestKey && !row.attemptKey));
    return [...groupRepairContexts(requestRows, 'request').entries()].flatMap(([groupKey, rows]) => {
      const reqReconcile = planRequestReconciliation(rows, rows[0].requestKey);
      if (reqReconcile.action !== 'ready') return [];
      const attempts = dedupeSystemRows(allItems.filter((row) => row?.id && row.attemptKey && row.requestKey === reqReconcile.canonical.requestKey));
      const plan = planSummaryLease(reqReconcile.canonical, reqReconcile.canonical.nowIso || new Date().toISOString(), attempts);
      return plan.action === 'call_coordinator' ? [{ json: { requestKey: reqReconcile.canonical.requestKey, __repairGroupKey: groupKey } }] : [];
    });
  }
  if (mode === 'presentation_plan') {
    const attempts = dedupeSystemRows(allItems.filter((row) => row?.id && row.attemptKey));
    return [...groupRepairContexts(attempts, 'attempt').entries()].flatMap(([groupKey, attemptRows]) => {
      const summaryRows = dedupeSystemRows(allItems.filter((row) => row?.id && !row.attemptKey && row.requestKey === attemptRows[0].requestKey));
      const attReconcile = planSameKeyReconciliation(attemptRows, 'attempt', summaryRows);
      if (attReconcile.action !== 'ready' || !attReconcile.canonical || attReconcile.canonical.status !== 'completed') return [];
      const plan = planPresentationRepair(attReconcile.canonical, attReconcile.canonical.nowIso || new Date().toISOString());
      return plan.action === 'claim' ? [{ json: { ...plan, __repairGroupKey: groupKey, __planCarrier: true, __planPhase: 'presentation-claim', repairMode: 'presentation_verify' } }] : [];
    });
  }
  if (mode === 'presentation_verify') {
    const items = allItems;
    const plan = items.find((row) => (row.repairClass === 'presentation_lease' && row.filters) || row.__planPhase === 'presentation-claim');
    const rows = items.filter((row) => row && row.id && row.attemptKey);
    if (!plan) throw new Error('Presentation repair plan provenance is missing');
    const verified = verifyPresentationRepair(rows, plan);
    return [{ json: { attemptKey: verified.canonical.attemptKey } }];
  }
  if (mode === 'duplicate_plan') {
    const attemptRows = dedupeSystemRows(allItems.filter((row) => row?.id && row.attemptKey));
    const requestRows = dedupeSystemRows(allItems.filter((row) => row?.id && row.requestKey && !row.attemptKey));
    if (!attemptRows.length) return []; // Request duplicate reads are not wired; fail closed rather than mixing contexts.
    return [...groupRepairContexts(attemptRows, 'attempt').entries()].flatMap(([groupKey, rows]) => {
      const summaryRows = requestRows.filter((row) => row.requestKey === rows[0].requestKey);
      const plan = planSameKeyReconciliation(rows, 'attempt', summaryRows);
      if (plan.action === 'ready') return [];
      const phase = plan.action === 'manual_review' ? 'duplicate-freeze' : 'duplicate-reconcile';
      return (plan.mutations || []).map((mutation) => ({ json: { mutation, kind: 'attempt', action: plan.action, winnerRowID: plan.winnerRowID || '', __repairGroupKey: groupKey, __planCarrier: true, __planPhase: phase, repairMode: 'duplicate_verify', nowIso: rows[0].nowIso || new Date().toISOString() } }));
    });
  }
  if (mode === 'duplicate_verify') {
    const carriers = allItems.filter((row) => row.__planCarrier && ['duplicate-reconcile', 'duplicate-freeze'].includes(row.__planPhase));
    for (const carrier of carriers) {
      const rows = dedupeSystemRows(allItems.filter((row) => row?.id && repairGroupKey(row, carrier.kind) === carrier.__repairGroupKey));
      verifySameKeyReconciliation(rows, { action: carrier.action, winnerRowID: carrier.winnerRowID, mutations: [carrier.mutation] }, carrier.kind);
    }
    return [];
  }
  throw new Error('Plan Repairs requires a repairMode');
}
