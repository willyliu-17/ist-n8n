const owner = $('Verify Failure Owner Snapshot').first().json;
if (!owner.id || !owner.attemptKey || owner.presentationLeaseOwner !== $execution.id) throw new Error('Verified presentation owner snapshot is unavailable');
if (!owner.failureSource || !owner.errorCode || typeof owner.potentialDuplicateUpload !== 'boolean') throw new Error('Invalid presentation failure context');
const attempt = Number(owner.presentationAttempt);
if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3) throw new Error('Invalid current presentation attempt');
const now = new Date().toISOString();
const terminal = attempt >= 3;
const delay = attempt === 1 ? 60_000 : 5 * 60_000;
return [{ json: {
  ...owner,
  desiredPresentationStatus: terminal ? 'failed' : 'retry_pending',
  desiredPresentationAttempt: attempt,
  desiredPresentationNextRetryAtIso: terminal ? '' : new Date(Date.parse(now) + delay).toISOString(),
  desiredPresentationErrorCode: owner.errorCode,
  failureAtIso: now,
} }];
