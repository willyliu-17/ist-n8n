function sanitizeStageError(source) {
  const carrier = source.carrier || (source.kind === 'carrier' ? source : null);
  if (!carrier || !carrier.input || !carrier.row) throw new Error('stage error lost direct carrier');
  if (!['inference', 'upload', 'message'].includes(carrier.nextStage)) throw new Error('stage error lacks explicit stage');
  const fallback = `summary_${carrier.nextStage}_failed`;
  const raw = String(source.error?.message || source.message || fallback);
  const errorCode = /^[A-Za-z0-9_.-]{1,96}$/.test(raw) ? raw : fallback;
  return { kind: 'failure_carrier', input: carrier.input, row: carrier.row, ownerConditions: carrier.ownerConditions, failureStage: carrier.nextStage, errorCode };
}
if (typeof module !== 'undefined') module.exports = { sanitizeStageError };
if (typeof $input !== 'undefined') return [{ json: sanitizeStageError($input.first().json || {}) }];
