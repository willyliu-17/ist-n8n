const SLACK_TS = /^\d{10,}\.\d{6}$/;

function verifyInitialSummaryStatus(rows, plan, executionID, nowIso = new Date().toISOString()) {
  const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicals.length !== 1) throw new Error('Expected exactly one canonical request after initial status checkpoint');
  const row = canonicals[0];
  if (row.id !== plan.id || row.requestKey !== plan.requestKey || row.channel !== plan.channel
    || row.threadTS !== plan.threadTS || row.canonicalRowID !== String(row.id)
    || row.status !== 'creating' || row.creationLeaseOwner !== executionID
    || row.creationLeaseUntilIso !== plan.expectedCreationLeaseUntilIso
    || !Number.isFinite(Date.parse(row.creationLeaseUntilIso))
    || Date.parse(row.creationLeaseUntilIso) <= Date.parse(nowIso)
    || row.summaryMessageTS !== plan.summaryMessageTS || !SLACK_TS.test(row.summaryMessageTS)
    || row.updatedAtIso !== plan.checkpointUpdatedAtIso || typeof row.updatedAtIso !== 'string'
    || !Number.isFinite(Date.parse(row.updatedAtIso))
    || row.inferenceResultJson !== plan.expectedInferenceResultJson
    || row.summaryMarkdown !== plan.expectedSummaryMarkdown
    || row.summaryUploadID !== plan.expectedSummaryUploadID) {
    throw new Error('Initial summary status checkpoint was not persisted exactly');
  }
  return plan;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { verifyInitialSummaryStatus };

if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json }) => json).filter((row) => row.id);
  return [{ json: verifyInitialSummaryStatus(rows, $('Parse Initial Summary Status').first().json, $execution.id) }];
}
