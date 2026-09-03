const rows = $input.all().map((item) => item.json).filter((row) => row && Object.keys(row).length > 0);
const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical');
if (canonicals.length !== 1) throw new Error('Expected exactly one failure canonical');
const owner = canonicals[0];
const claims = $('Claim Presentation').all().map((item) => item.json).filter((item) => item && Object.keys(item).length > 0);
if (claims.length !== 1) throw new Error('Original presentation claim is unavailable');
const claim = claims[0];
const immutableFields = [
  'id', 'attemptKey', 'attempt', 'dialogue', 'language', 'logicalJobKey', 'requestKey', 'requestType', 'role', 'streamID', 'mode',
  'durationMinutes', 'streamContextJson', 'channel', 'threadTS', 'processingMessageTS',
];
for (const field of immutableFields) {
  if (owner[field] !== claim[field]) throw new Error(`Failure claim provenance mismatch: ${field}`);
}
if (owner.canonicalRowID !== String(owner.id) || owner.status !== 'completed' || owner.presentationStatus !== 'presenting') throw new Error('Failure canonical is not presenting');
if (owner.presentationLeaseOwner !== $execution.id || owner.presentationLeaseOwner !== claim.presentationLeaseOwner) throw new Error('Failure presentation owner mismatch');
if (owner.presentationLeaseUntilIso !== claim.presentationLeaseUntilIso) throw new Error('Failure presentation lease changed');
const leaseUntil = Date.parse(owner.presentationLeaseUntilIso);
if (!Number.isFinite(leaseUntil) || new Date(leaseUntil).toISOString() !== owner.presentationLeaseUntilIso || leaseUntil <= Date.now()) throw new Error('Failure presentation lease expired');
const context = $('Failure Context').first().json;
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
if (Object.keys(context).sort().join(',') !== 'errorCode,failureSource,potentialDuplicateUpload') throw new Error('Invalid sanitized presentation error context fields');
const expectedContext = allowedContexts[context.failureSource];
if (!expectedContext || context.errorCode !== expectedContext[0] || context.potentialDuplicateUpload !== expectedContext[1]) throw new Error('Invalid sanitized presentation error context');
const attempt = Number(owner.presentationAttempt);
if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3 || attempt !== Number(claim.presentationAttempt)) throw new Error('Failure presentation attempt mismatch');
const now = new Date().toISOString();
const terminal = attempt >= 3;
const delay = attempt === 1 ? 60_000 : 5 * 60_000;
console.log(JSON.stringify({
  event: 'presentation_failure_planned',
  executionId: $execution.id,
  rowId: owner.id,
  presentationAttempt: attempt,
  failureSource: context.failureSource,
  errorCode: context.errorCode,
  potentialDuplicateUpload: context.potentialDuplicateUpload,
}));
return [{ json: {
  ...owner,
  failureSource: context.failureSource,
  errorCode: context.errorCode,
  potentialDuplicateUpload: context.potentialDuplicateUpload,
  desiredPresentationStatus: terminal ? 'failed' : 'retry_pending',
  desiredPresentationAttempt: attempt,
  desiredPresentationNextRetryAtIso: terminal ? '' : new Date(Date.parse(now) + delay).toISOString(),
  desiredPresentationErrorCode: owner.errorCode,
  failureAtIso: now,
} }];
