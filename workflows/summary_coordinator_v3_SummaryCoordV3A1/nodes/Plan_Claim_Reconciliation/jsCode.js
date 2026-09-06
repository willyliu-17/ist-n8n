const REQUEST_STAGES = new Set(['ready', 'summary_dispatching', 'summary_retry_pending', 'completed']);
const CHECKPOINTS = ['inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS'];

function nonempty(value) { return typeof value === 'string' && value.trim() !== ''; }
function systemRowID(value) { return Number.isInteger(value) && value > 0; }
function strictIso(value, name) {
  if (!nonempty(value) || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) throw new Error(`invalid ${name}`);
  return Date.parse(value);
}
function json(value, name, predicate) {
  if (!nonempty(value)) throw new Error(`${name} must be nonempty JSON`);
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${name} must be valid JSON`); }
  if (JSON.stringify(parsed) !== value || (predicate && !predicate(parsed))) throw new Error(`invalid ${name}`);
  return parsed;
}
function compareRows(left, right) {
  strictIso(left.createdAt, 'createdAt'); strictIso(right.createdAt, 'createdAt');
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}
function hasCheckpoint(row) { return CHECKPOINTS.some((key) => nonempty(row[key] || '')); }
function logicalKey(request, stream) { return `${request.requestKey}:${stream.role}:${stream.liveStreamID}:${stream.mode}`; }
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requestImmutables(row) {
  const streams = json(row.orderedStreamsJson, 'orderedStreamsJson', Array.isArray);
  const expected = json(row.expectedLogicalJobKeysJson, 'expectedLogicalJobKeysJson', Array.isArray);
  const existing = json(row.existingDialoguesJson, 'existingDialoguesJson', (value) => value && !Array.isArray(value));
  if (!streams.length || new Set(expected).size !== expected.length) throw new Error('request immutable fields mismatch');
  const roles = new Set();
  streams.forEach((stream) => {
    const context = stream?.streamContext;
    const sttEligible = stream?.sttEligible !== false;
    if (!stream || !nonempty(stream.role) || roles.has(stream.role) || !nonempty(String(stream.liveStreamID)) || !['fromStart', 'fromEnd'].includes(stream.mode)
      || Object.hasOwn(stream, 'sttEligible') && typeof stream.sttEligible !== 'boolean'
      || !plainObject(context) || String(context.liveStreamID) !== String(stream.liveStreamID)
      || sttEligible && (context.eligible !== true || !Number.isFinite(context.beginTime)
        || !Number.isFinite(context.endTime) || context.endTime < context.beginTime)) throw new Error('invalid ordered stream');
    roles.add(stream.role);
  });
  for (const [role, dialogue] of Object.entries(existing)) {
    const stream = streams.find((candidate) => candidate.role === role);
    if (!stream || !dialogue || dialogue.logicalJobKey !== logicalKey(row, stream) || !nonempty(dialogue.dialogue)) throw new Error('invalid existing dialogue');
  }
  const expectedFromStreams = streams
    .filter((stream) => stream.sttEligible !== false && !existing[stream.role])
    .map((stream) => logicalKey(row, stream));
  if (JSON.stringify(expectedFromStreams) !== JSON.stringify(expected)) throw new Error('expected logical identity mismatch');
}
function validateRequestRows(rows, requestKey) {
  if (!nonempty(requestKey) || !Array.isArray(rows) || rows.length === 0) throw new Error('request rows not found');
  let baseline;
  for (const row of rows) {
    if (!row || row.requestKey !== requestKey || !systemRowID(row.id) || !nonempty(row.requestType)) throw new Error('invalid request system fields or key');
    strictIso(row.createdAt, 'createdAt'); strictIso(row.updatedAt, 'updatedAt');
    if (!['pending', 'canonical', 'duplicate'].includes(row.reconciliationStatus)) throw new Error('invalid request reconciliation status');
    if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== String(row.id)) throw new Error('canonical request self-link mismatch');
    if (row.reconciliationStatus === 'pending' && (row.canonicalRowID || '') !== '') throw new Error('pending request must have empty canonical link');
    if (row.reconciliationStatus === 'duplicate' && !nonempty(row.canonicalRowID)) throw new Error('duplicate request must link to canonical');
    requestImmutables(row);
    const immutable = [row.requestType, row.orderedStreamsJson, row.existingDialoguesJson, row.expectedLogicalJobKeysJson, row.channel, row.threadTS].join('\u0000');
    if (baseline !== undefined && baseline !== immutable) throw new Error('request immutable replay mismatch');
    baseline = immutable;
  }
}
function reconcileMutation(row, winnerRowID, desired) {
  return { id: row.id, requestKey: row.requestKey, expectedStatus: row.status, expectedReconciliationStatus: row.reconciliationStatus, expectedCanonicalRowID: row.canonicalRowID || '', expectedUpdatedAt: row.updatedAt, desiredReconciliationStatus: desired, desiredCanonicalRowID: String(winnerRowID) };
}
function planRequestReconciliation(rows, requestKey) {
  validateRequestRows(rows, requestKey);
  const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicals.length > 1 && rows.some(hasCheckpoint)) {
    return { action: 'manual_review', reason: 'multiple_canonical_checkpoint_conflict', mutations: canonicals.map((row) => {
      if (!REQUEST_STAGES.has(row.status)) throw new Error('checkpoint conflict has invalid original stage');
      return { id: row.id, requestKey, expectedStatus: row.status, expectedReconciliationStatus: 'canonical', expectedCanonicalRowID: String(row.id), expectedUpdatedAt: row.updatedAt, manualReviewOriginalStage: row.status };
    }) };
  }
  const winner = canonicals.length ? [...canonicals].sort(compareRows)[0] : [...rows].sort(compareRows)[0];
  const mutations = rows.filter((row) => row.id !== winner.id || row.reconciliationStatus !== 'canonical' || row.canonicalRowID !== String(winner.id)).map((row) => reconcileMutation(row, winner.id, row.id === winner.id ? 'canonical' : 'duplicate'));
  return mutations.length ? { action: 'reconcile', winnerRowID: winner.id, mutations } : { action: 'ready', winnerRowID: winner.id, canonical: winner };
}
function planClaimReconciliation(rows, requestKey) { return planRequestReconciliation(rows, requestKey); }
if (typeof module !== 'undefined' && module.exports) module.exports = { plainObject, planClaimReconciliation };
if (typeof $input !== 'undefined') {
  const plan = planClaimReconciliation($input.all().map(({ json: row }) => row).filter((row) => row && Object.hasOwn(row, 'id')), $('Start').first().json.requestKey);
  if (plan.action === 'ready') return [{ json: { ...plan.canonical, action: 'ready' } }];
  return plan.mutations.map((mutation) => ({ json: { ...mutation, action: plan.action } }));
}
