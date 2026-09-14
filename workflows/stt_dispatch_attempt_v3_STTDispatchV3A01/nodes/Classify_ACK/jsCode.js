const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_AUTOMATIC_ATTEMPTS = 20;
const RETRY_SLOT_MINUTES = Object.freeze([1, 2, 4, 6, 9, 13, 18, 25, 35, 48, 65, 88, 118, 158, 211, 281, 374, 497, 660]);
const RETRY_DEADLINE_MINUTES = 720;
const SUMMARY_RETRY_SLOT_MINUTES = Object.freeze([1, 2, 4, 6, 9, 13, 18, 25]);
const SUMMARY_RETRY_DEADLINE_MINUTES = 30;

function addMinutes(iso, minutes) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid classification timestamp');
  return new Date(timestamp + minutes * 60_000).toISOString();
}

function requireRequest(requestRows, requestKey) {
  const rows = (Array.isArray(requestRows) ? requestRows : []).filter((row) => row && Object.hasOwn(row, 'id'));
  const canonical = rows.filter((row) => row.requestKey === requestKey && row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
  if (canonical.length !== 1) throw new Error('Expected exactly one canonical summary request');
  addMinutes(canonical[0].createdAt, 0);
  if (typeof canonical[0].requestType !== 'string' || canonical[0].requestType === '') throw new Error('Invalid request type');
  return canonical[0];
}

function timingSource(attempt, requestRows) {
  if (attempt.requestType === 'standalone_stt') {
    if (attempt.requestKey !== attempt.logicalJobKey) throw new Error('Invalid standalone request linkage');
    addMinutes(attempt.createdAt, 0);
    return attempt;
  }
  return requireRequest(requestRows, attempt.requestKey);
}

function retryPolicy(requestType) {
  return requestType === 'standalone_stt'
    ? { slots: RETRY_SLOT_MINUTES, deadlineMinutes: RETRY_DEADLINE_MINUTES }
    : { slots: SUMMARY_RETRY_SLOT_MINUTES, deadlineMinutes: SUMMARY_RETRY_DEADLINE_MINUTES };
}

function retryTiming(requestCreatedAtIso, attemptNumber, requestType = 'standalone_stt') {
  const attempt = Number(attemptNumber);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Invalid attempt number');
  const policy = retryPolicy(requestType);
  const deadlineAtIso = addMinutes(requestCreatedAtIso, policy.deadlineMinutes);
  return {
    deadlineAtIso,
    nextRetryAtIso: attempt <= policy.slots.length
      ? addMinutes(requestCreatedAtIso, policy.slots[attempt - 1])
      : '',
  };
}

function classifyAck(outcome, attempt, requestRows, nowIso = new Date().toISOString()) {
  const attemptNumber = Number(attempt?.attempt);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error('Invalid attempt number');
  }
  const request = timingSource(attempt, requestRows);
  const timing = retryTiming(request.createdAt, attemptNumber, request.requestType);
  const maximumAttempts = retryPolicy(request.requestType).slots.length + 1;
  const now = Date.parse(addMinutes(nowIso, 0));
  if (outcome?.transportError === true) {
    return {
      classification: 'ambiguous_transport',
      status: 'manual_review',
      manualReviewReason: 'vds_submit_outcome_ambiguous',
      manualReviewAtIso: nowIso,
      nextRetryAtIso: '',
    };
  }

  const statusCode = Number(outcome?.statusCode);
  if (!Number.isInteger(statusCode)) {
    return {
      classification: 'ambiguous_transport',
      status: 'manual_review',
      manualReviewReason: 'vds_submit_outcome_ambiguous',
      manualReviewAtIso: nowIso,
      nextRetryAtIso: '',
    };
  }
  if (statusCode >= 200 && statusCode <= 299) {
    return {
      classification: 'accepted',
      status: 'waiting_callback',
      submittedAtIso: nowIso,
      callbackDeadlineAtIso: attemptNumber <= maximumAttempts
        ? (timing.nextRetryAtIso || timing.deadlineAtIso)
        : addMinutes(nowIso, 24 * 60),
    };
  }
  if (RETRYABLE_HTTP_STATUSES.has(statusCode)) {
    if (attemptNumber >= maximumAttempts || now >= Date.parse(timing.deadlineAtIso)) {
      return {
        classification: 'retry_exhausted',
        status: 'failed',
        errorCode: `vds_http_${statusCode}`,
        nextRetryAtIso: '',
      };
    }
    return {
      classification: 'retryable_http_failure',
      status: 'retry_pending',
      errorCode: `vds_http_${statusCode}`,
      nextRetryAtIso: timing.nextRetryAtIso,
    };
  }
  return {
    classification: 'terminal_http_failure',
    status: 'failed',
    errorCode: `vds_http_${statusCode}`,
    nextRetryAtIso: '',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MAX_AUTOMATIC_ATTEMPTS,
    RETRY_DEADLINE_MINUTES,
    RETRY_SLOT_MINUTES,
    SUMMARY_RETRY_DEADLINE_MINUTES,
    SUMMARY_RETRY_SLOT_MINUTES,
    classifyAck,
    retryTiming,
  };
}

if (typeof $input !== 'undefined') {
  const outcome = $input.first().json;
  const canonical = $('Require Canonical Owner Before Submit').first().json;
  const result = classifyAck(outcome, canonical, $('Read Summary Request Rows').all().map(({ json }) => json));
  return [{
    json: {
      ...result,
      attemptKey: canonical.attemptKey,
      dispatchLeaseOwner: canonical.dispatchLeaseOwner,
      dispatchLeaseUntilIso: canonical.dispatchLeaseUntilIso,
    },
  }];
}
