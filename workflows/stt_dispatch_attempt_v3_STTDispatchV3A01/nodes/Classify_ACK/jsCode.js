const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

function addMinutes(iso, minutes) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid classification timestamp');
  return new Date(timestamp + minutes * 60_000).toISOString();
}

function classifyAck(outcome, attempt, nowIso = new Date().toISOString()) {
  const attemptNumber = Number(attempt?.attempt);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 3) {
    throw new Error('Invalid attempt number');
  }
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
      callbackDeadlineAtIso: addMinutes(nowIso, 30),
    };
  }
  if (RETRYABLE_HTTP_STATUSES.has(statusCode)) {
    if (attemptNumber === 3) {
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
      nextRetryAtIso: addMinutes(nowIso, attemptNumber === 1 ? 1 : 5),
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
  module.exports = { classifyAck };
}

if (typeof $input !== 'undefined') {
  const outcome = $input.first().json;
  const canonical = $('Require Canonical Owner Before Submit').first().json;
  const result = classifyAck(outcome, canonical);
  return [{
    json: {
      ...result,
      attemptKey: canonical.attemptKey,
      dispatchLeaseOwner: canonical.dispatchLeaseOwner,
      dispatchLeaseUntilIso: canonical.dispatchLeaseUntilIso,
    },
  }];
}
