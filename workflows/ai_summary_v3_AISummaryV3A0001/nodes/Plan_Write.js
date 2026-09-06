function currentOwner(carrier, rows) {
  if (!carrier || !carrier.input || !carrier.row || !Array.isArray(rows)) throw new Error('write plan requires carrier and latest rows');
  const canonical = rows.filter((item) => item && item.reconciliationStatus === 'canonical' && item.canonicalRowID === String(item.id));
  if (canonical.length !== 1) throw new Error('latest canonical gate failed');
  const row = canonical[0];
  if (row.id !== carrier.row.id || row.status !== 'summary_dispatching' || row.leaseOwner !== carrier.row.leaseOwner || row.leaseUntilIso !== carrier.row.leaseUntilIso || Date.parse(row.leaseUntilIso) <= Date.now()) throw new Error('latest owner gate failed');
  return row;
}
function planWrite(items) {
  const carrier = items.find((item) => item?.kind === 'carrier');
  const row = currentOwner(carrier, items.filter((item) => item?.id));
  const values = carrier.nextStage === 'inference' ? { inferenceResultJson: carrier.inferenceResultJson, summaryMarkdown: carrier.summaryMarkdown } : carrier.nextStage === 'upload' ? { summaryUploadID: carrier.checkpointValue } : carrier.nextStage === 'message' ? { summaryMessageTS: carrier.checkpointValue } : carrier.nextStage === 'complete' ? { status: 'completed', nextRetryAtIso: '', errorCode: '', leaseOwner: '', leaseUntilIso: '' } : null;
  const requiredValues = carrier.nextStage === 'complete' ? [values?.status] : Object.values(values || {});
  if (!values || requiredValues.some((value) => value === undefined || value === '')) throw new Error('checkpoint payload missing');
  return { kind: 'plan', input: carrier.input, requestKey: carrier.input.requestKey, row, ownerConditions: carrier.ownerConditions, nextStage: carrier.nextStage, values };
}
if (typeof module !== 'undefined') module.exports = { currentOwner, planWrite };
if (typeof $input !== 'undefined') return [{ json: planWrite($input.all().map(({ json }) => json)) }];
