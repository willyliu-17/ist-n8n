const attempts = $('Read Before Side Effect').all().map((item) => item.json).filter((row) => row && Object.keys(row).length);
const summaries = $input.all().map((item) => item.json).filter((row) => row && Object.keys(row).length);
if (!attempts.length) throw new Error('Attempt row not found before side effect');
const { attemptKey, requestKey } = attempts[0];
for (const row of attempts) {
  if (!row.id || !row.createdAt || !row.updatedAt || row.attemptKey !== attemptKey || row.requestKey !== requestKey) throw new Error('Invalid same-attempt rows before side effect');
  if (!['pending', 'canonical', 'duplicate'].includes(row.reconciliationStatus)) throw new Error('Invalid reconciliation status before side effect');
  if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== row.id) throw new Error('Invalid canonical linkage before side effect');
  if (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') throw new Error('Invalid pending linkage before side effect');
  if (row.reconciliationStatus === 'duplicate' && !row.canonicalRowID) throw new Error('Invalid duplicate linkage before side effect');
}
if (summaries.some((row) => row.requestKey !== requestKey)) throw new Error('Summary requestKey mismatch');
const attemptCheckpoints = ['submittedAtIso', 'callbackDeadlineAtIso', 'consumedAtIso', 'dialogue', 'transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso'];
const summaryCheckpoints = ['inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS'];
const present = (value) => value !== undefined && value !== null && value !== '';
const canonical = attempts.filter((row) => row.reconciliationStatus === 'canonical');
if (canonical.length === 1) {
  const winner = canonical[0];
  const staleRows = attempts.filter((row) => row.id !== winner.id && (row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== winner.id));
  if (staleRows.length) {
    return staleRows.map((row) => ({ json: {
      id: row.id, attemptKey: row.attemptKey, expectedStatus: row.status,
      expectedReconciliationStatus: row.reconciliationStatus, expectedCanonicalRowID: row.canonicalRowID || '',
      desiredReconciliationStatus: 'duplicate', desiredCanonicalRowID: winner.id,
      reconciliationAction: 'reconcile',
    } }));
  }
}
if (canonical.length !== 1) {
  if (canonical.length > 1 && (attempts.some((row) => attemptCheckpoints.some((field) => present(row[field]))) || summaries.some((row) => summaryCheckpoints.some((field) => present(row[field]))))) {
    return canonical.map((row) => ({ json: {
      id: row.id, attemptKey: row.attemptKey, expectedStatus: row.status,
      expectedReconciliationStatus: 'canonical', expectedCanonicalRowID: row.id,
      desiredReconciliationStatus: 'canonical', desiredCanonicalRowID: row.id,
      reconciliationAction: 'manual_review',
    } }));
  }
  const sorted = [...canonical.length ? canonical : attempts].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const winner = sorted[0];
  return attempts.filter((row) => row.id !== winner.id || row.reconciliationStatus !== 'canonical').map((row) => ({ json: {
    id: row.id, attemptKey: row.attemptKey, expectedStatus: row.status,
    expectedReconciliationStatus: row.reconciliationStatus, expectedCanonicalRowID: row.canonicalRowID || '',
    desiredReconciliationStatus: row.id === winner.id ? 'canonical' : 'duplicate', desiredCanonicalRowID: winner.id,
    reconciliationAction: 'reconcile',
  } }));
}
const row = canonical[0];
const now = new Date().toISOString();
if (row.canonicalRowID !== row.id || row.status !== 'completed' || !String(row.dialogue || '').trim()) throw new Error('Invalid canonical owner state');
if (row.id !== $('Require Presentation Owner').first().json.id) throw new Error('Claimed canonical ID changed');
if (row.presentationStatus !== 'presenting' || row.presentationLeaseOwner !== $execution.id) throw new Error('Presentation owner mismatch');
if (!row.presentationLeaseUntilIso || Date.parse(row.presentationLeaseUntilIso) <= Date.parse(now) || new Date(Date.parse(row.presentationLeaseUntilIso)).toISOString() !== row.presentationLeaseUntilIso) throw new Error('Presentation lease expired');
if (row.channel !== 'C0A4JJJKJMD') throw new Error('Invalid presentation channel');
const stage = !row.transcriptUploadID ? 'transcript' : !row.analysisUploadID ? 'analysis' : !row.processingMessageUpdatedAtIso ? 'message_update' : 'complete';
if (stage === 'complete') throw new Error('No side effect remains');
return [{ json: { ...row, presentationStage: stage, reconciliationAction: 'ready' } }];
