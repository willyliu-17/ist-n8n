const source = $input.first().json || {};
const carrier = source.carrier || (source.kind === 'carrier' ? source : null);
if (!carrier || !carrier.input || !carrier.row) throw new Error('stage error lost direct carrier');
const raw = String(source.error?.message || source.message || 'summary_stage_failed');
const errorCode = /^[A-Za-z0-9_.-]{1,96}$/.test(raw) ? raw : 'summary_stage_failed';
if (!['inference', 'upload', 'message'].includes(carrier.nextStage)) throw new Error('stage error lacks explicit stage');
return [{ json: { kind: 'failure_carrier', input: carrier.input, row: carrier.row, ownerConditions: carrier.ownerConditions, failureStage: carrier.nextStage, errorCode } }];
