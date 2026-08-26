const input = $input.all().map(({ json }) => json).find((item) => item && item.kind === 'carrier');
const rows = $input.all().map(({ json }) => json).filter((item) => item && item.id);
if (!input || rows.length === 0) throw new Error('stage planner requires direct carrier and full request rows');
const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
const checkpoints = ['inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS'];
if (canonical.length !== 1) {
  const action = canonical.length > 1 && rows.some((row) => checkpoints.some((key) => String(row[key] || '').trim())) ? 'freeze' : 'reconcile';
  const winner = [...canonical].sort((a, b) => String(a.createdAtIso).localeCompare(String(b.createdAtIso)))[0];
  if (!winner) throw new Error('stage planner requires one existing canonical winner');
  const targets = action === 'freeze' ? canonical : canonical.filter((row) => row.id !== winner.id);
  return targets.map((row) => ({ json: {
    kind: 'plan',
    action,
    input: input.input,
    requestKey: input.input.requestKey,
    row,
    winnerId: winner.id,
    expectedStatus: row.status,
    expectedReconciliationStatus: row.reconciliationStatus,
    expectedCanonicalRowID: row.canonicalRowID,
    expectedUpdatedAtIso: row.updatedAtIso || '',
    values: action === 'freeze'
      ? { status: 'manual_review', manualReviewReason: 'multiple_canonical_checkpoint_conflict', manualReviewAtIso: new Date().toISOString(), manualReviewOriginalStage: row.status, leaseOwner: '', leaseUntilIso: '' }
      : { reconciliationStatus: 'duplicate', canonicalRowID: String(winner.id) },
  } }));
}
const row = canonical[0];
if (row.status !== 'summary_dispatching' || !row.leaseOwner || !row.leaseUntilIso || Date.parse(row.leaseUntilIso) <= Date.now()) throw new Error('stage owner lease is not current');
const stage = !row.inferenceResultJson || !row.summaryMarkdown ? 'inference' : !row.summaryUploadID ? 'upload' : !row.summaryMessageTS ? 'message' : 'complete';
return [{ json: { kind: 'carrier', action: stage, input: input.input, requestKey: input.input.requestKey, row, ownerConditions: { id: row.id, requestKey: row.requestKey, status: row.status, reconciliationStatus: 'canonical', canonicalRowID: String(row.id), leaseOwner: row.leaseOwner, leaseUntilIso: row.leaseUntilIso }, nextStage: stage } }];
