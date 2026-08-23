const rows = $input.all().map((item) => item.json).filter((row) => row && Object.keys(row).length);
const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical');
const initialFreeze = $('Freeze Canonical Conflict').isExecuted;
const postClaimFreeze = $('Post-claim Freeze Canonical Conflict').isExecuted;
if ((initialFreeze || postClaimFreeze) && !$('Complete Presentation').isExecuted && !$('Patch Presentation Failure').isExecuted) {
  const planNode = postClaimFreeze ? 'Post-claim Freeze Conflict Plan' : 'Freeze Conflict Plan';
  const expectedIDs = new Set($(planNode).all().map((item) => item.json.id));
  if (canonical.length !== expectedIDs.size) throw new Error('Canonical conflict freeze is incomplete');
  for (const row of canonical) {
    if (!expectedIDs.has(row.id) || row.canonicalRowID !== row.id || row.status !== 'manual_review' || row.manualReviewReason !== 'multiple_canonical_checkpoint_conflict') throw new Error('Canonical conflict was not fully frozen');
    const timestamp = Date.parse(row.manualReviewAtIso);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== row.manualReviewAtIso) throw new Error('Frozen canonical manual review time is invalid');
    if (row.presentationLeaseOwner !== '' || row.presentationLeaseUntilIso !== '') throw new Error('Frozen canonical presentation lease was not cleared');
  }
  return [{ json: { attemptKey: canonical[0]?.attemptKey || '', presentationStatus: 'manual_review', zeroSlack: true } }];
}
if (canonical.length !== 1 || canonical[0].canonicalRowID !== canonical[0].id) throw new Error('Expected one canonical state');
const row = canonical[0];
if ($('Patch Presentation Failure').isExecuted) {
  const expected = $('Plan Presentation Failure').first().json;
  if (row.id !== expected.id || row.presentationStatus !== expected.desiredPresentationStatus || row.presentationAttempt !== expected.desiredPresentationAttempt || row.presentationNextRetryAtIso !== expected.desiredPresentationNextRetryAtIso || row.presentationErrorCode !== expected.desiredPresentationErrorCode || row.presentationLeaseOwner !== '' || row.presentationLeaseUntilIso !== '') throw new Error('Presentation failure patch was not confirmed');
  return [{ json: { requestKey: row.requestKey, logicalJobKey: row.logicalJobKey, attemptKey: row.attemptKey, presentationStatus: row.presentationStatus, presentationAttempt: row.presentationAttempt, presentationErrorCode: row.presentationErrorCode } }];
}
if ($('Complete Presentation').isExecuted) {
  const expectation = $('Prepare Completion Snapshot').first().json.completionExpectation;
  if (row.canonicalRowID !== row.id || row.status !== 'completed' || row.presentationStatus !== 'completed') throw new Error('Presentation completion was not confirmed');
  if (row.presentationLeaseOwner !== '' || row.presentationLeaseUntilIso !== '') throw new Error('Presentation completion lease was not cleared');
  for (const [field, value] of Object.entries(expectation.expectedClaim || {})) {
    if (row[field] !== value) throw new Error(`Completion claim mismatch: ${field}`);
  }
  const checkpointFields = ['transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso'];
  if (Object.keys(expectation.expectedCheckpoints || {}).length !== checkpointFields.length) throw new Error('Completion checkpoints are incomplete');
  for (const field of checkpointFields) {
    if (row[field] !== expectation.expectedCheckpoints[field]) throw new Error(`Completion checkpoint mismatch: ${field}`);
  }
  return [{ json: { attemptKey: row.attemptKey, presentationStatus: row.presentationStatus, transcriptUploadID: row.transcriptUploadID, analysisUploadID: row.analysisUploadID, processingMessageUpdatedAtIso: row.processingMessageUpdatedAtIso } }];
}
const owner = $('Guard Side Effect Owner').first().json;
const expected = owner.presentationStage === 'transcript'
  ? $('Extract Transcript Upload ID').first().json
  : owner.presentationStage === 'analysis'
    ? $('Extract Analysis Upload ID').first().json
    : $('Prepare Message Checkpoint').first().json;
if (row.canonicalRowID !== row.id || row.status !== 'completed' || row.presentationStatus !== 'presenting') throw new Error('Checkpoint canonical state mismatch');
for (const field of ['id', 'attemptKey', 'canonicalRowID', 'status', 'presentationStatus', 'presentationLeaseOwner', 'presentationLeaseUntilIso', 'presentationAttempt']) {
  if (row[field] !== expected[field]) throw new Error(`Checkpoint provenance mismatch: ${field}`);
}
if (row.presentationLeaseOwner !== $execution.id || Date.parse(row.presentationLeaseUntilIso) <= Date.now()) throw new Error('Checkpoint owner was not confirmed');
const stage = owner.presentationStage;
if (row[expected.checkpointField] !== expected.checkpointValue) throw new Error('Checkpoint exact value was not confirmed');
return [{ json: row }];
