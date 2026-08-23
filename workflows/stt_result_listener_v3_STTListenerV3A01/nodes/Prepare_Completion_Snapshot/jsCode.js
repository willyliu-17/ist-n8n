const COMPLETION_PROVENANCE_FIELDS = [
  'logicalJobKey', 'requestKey', 'requestType', 'role', 'streamID', 'mode',
  'durationMinutes', 'streamContextJson', 'channel', 'threadTS', 'processingMessageTS',
];
const PRESENTATION_CHECKPOINT_FIELDS = [
  'transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso',
];
const claim = $('Require Presentation Owner').first().json;
const checkpoint = $input.first().json;
if (claim.id !== checkpoint.id || claim.attemptKey !== checkpoint.attemptKey) throw new Error('Completion snapshot identity mismatch');
const claimFields = ['id', 'attemptKey', 'attempt', 'presentationAttempt', ...COMPLETION_PROVENANCE_FIELDS];
const expectedClaim = Object.fromEntries(claimFields.map((field) => [field, claim[field]]));
const expectedCheckpoints = Object.fromEntries(PRESENTATION_CHECKPOINT_FIELDS.map((field) => [field, checkpoint[field]]));
if (PRESENTATION_CHECKPOINT_FIELDS.some((field) => typeof expectedCheckpoints[field] !== 'string' || !expectedCheckpoints[field])) throw new Error('Completion checkpoint is missing');
return [{ json: { ...checkpoint, completionExpectation: { expectedClaim, expectedCheckpoints } } }];
