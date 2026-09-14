function sanitizeStageError(source) {
  const carrier = source.carrier || (source.kind === 'carrier' ? source : null);
  if (!carrier || !carrier.input || !carrier.row) throw new Error('stage error lost direct carrier');
  if (!['status', 'inference', 'upload', 'complete'].includes(carrier.nextStage)) throw new Error('stage error lacks explicit stage');
  const fallback = `summary_${carrier.nextStage}_failed`;
  const raw = String(source.error?.message || (typeof source.error === 'string' ? source.error : '') || source.message || fallback);
  // Unlike $, this end assertion also rejects a trailing line terminator.
  const errorCode = /^[A-Za-z0-9_.-]{1,96}(?![\s\S])/.test(raw)
    ? raw
    : /^(summary_model_output_invalid|summary_model_empty_response|summary_analysis_scope_invalid|summary_analysis_scope_mismatch) \[line [1-9]\d*\](?![\s\S])/.exec(raw)?.[1] || fallback;
  return { kind: 'failure_carrier', input: carrier.input, row: carrier.row, ownerConditions: carrier.ownerConditions, failureStage: carrier.nextStage, errorCode };
}
if (typeof module !== 'undefined') module.exports = { sanitizeStageError };
if (typeof $input !== 'undefined') return [{ json: sanitizeStageError($input.first().json || {}) }];
