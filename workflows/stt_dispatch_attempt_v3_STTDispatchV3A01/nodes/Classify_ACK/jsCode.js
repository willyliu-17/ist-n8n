const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_AUTOMATIC_ATTEMPTS = 20;
const RETRY_SLOT_MINUTES = Object.freeze([1, 2, 4, 6, 9, 13, 18, 25, 35, 48, 65, 88, 118, 158, 211, 281, 374, 497, 660]);
const RETRY_DEADLINE_MINUTES = 720;

function addMinutes(iso, minutes) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid classification timestamp');
  return new Date(timestamp + minutes * 60_000).toISOString();
}

function requireRequestStart(requestRows, requestKey) {
  const rows = (Array.isArray(requestRows) ? requestRows : []).filter((row) => row && Object.hasOwn(row, 'id'));
  const canonical = rows.filter((row) => row.requestKey === requestKey && row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
  if (canonical.length !== 1) throw new Error('Expected exactly one canonical summary request');
  addMinutes(canonical[0].createdAt, 0);
  return canonical[0].createdAt;
}

function retryTiming(requestCreatedAtIso, attemptNumber) {
  const attempt = Number(attemptNumber);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Invalid attempt number');
  const deadlineAtIso = addMinutes(requestCreatedAtIso, RETRY_DEADLINE_MINUTES);
  if (attempt >= MAX_AUTOMATIC_ATTEMPTS) return { deadlineAtIso, nextRetryAtIso: '' };
  return { deadlineAtIso, nextRetryAtIso: addMinutes(requestCreatedAtIso, RETRY_SLOT_MINUTES[attempt - 1]) };
}

function classifyAck(outcome, attempt, requestRows, nowIso = new Date().toISOString()) {
  const attemptNumber = Number(attempt?.attempt);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error('Invalid attempt number');
  }
  const requestCreatedAtIso = requireRequestStart(requestRows, attempt.requestKey);
  const timing = retryTiming(requestCreatedAtIso, attemptNumber);
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
      callbackDeadlineAtIso: attemptNumber <= MAX_AUTOMATIC_ATTEMPTS
        ? (timing.nextRetryAtIso || timing.deadlineAtIso)
        : addMinutes(nowIso, 24 * 60),
    };
  }
  if (RETRYABLE_HTTP_STATUSES.has(statusCode)) {
    if (attemptNumber >= MAX_AUTOMATIC_ATTEMPTS || now >= Date.parse(timing.deadlineAtIso)) {
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
  module.exports = { MAX_AUTOMATIC_ATTEMPTS, RETRY_DEADLINE_MINUTES, RETRY_SLOT_MINUTES, classifyAck, retryTiming };
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
