const PENDING = new Set(['queued', 'dispatching', 'waiting_callback', 'retry_pending', 'retry_materializing']);
const TERMINAL = new Set(['failed', 'timed_out']);
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
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function requestImmutables(row) {
  const streams = json(row.orderedStreamsJson, 'orderedStreamsJson', Array.isArray);
  const expected = json(row.expectedLogicalJobKeysJson, 'expectedLogicalJobKeysJson', Array.isArray);
  const existing = json(row.existingDialoguesJson, 'existingDialoguesJson', (value) => value && !Array.isArray(value));
  if (!streams.length || streams.length !== expected.length || new Set(expected).size !== expected.length) throw new Error('request immutable fields mismatch');
  const roles = new Set();
  streams.forEach((stream, index) => {
    const context = stream?.streamContext;
    if (!stream || !nonempty(stream.role) || roles.has(stream.role) || !nonempty(String(stream.liveStreamID)) || !['fromStart', 'fromEnd'].includes(stream.mode)
      || !plainObject(context) || String(context.liveStreamID) !== String(stream.liveStreamID) || context.eligible !== true
      || !Number.isFinite(context.beginTime) || !Number.isFinite(context.endTime) || context.endTime < context.beginTime) throw new Error('invalid ordered stream');
    roles.add(stream.role);
    if (expected[index] !== logicalKey(row, stream)) throw new Error('expected logical identity mismatch');
  });
  for (const [role, dialogue] of Object.entries(existing)) {
    const stream = streams.find((candidate) => candidate.role === role);
    if (!stream || !dialogue || dialogue.logicalJobKey !== logicalKey(row, stream) || !nonempty(dialogue.dialogue)) throw new Error('invalid existing dialogue');
  }
  return { streams, expected, existing };
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
function validateAttempt(row, request, expected, streams) {
  if (!systemRowID(row?.id)) throw new Error('invalid attempt id');
  for (const field of ['createdAt', 'updatedAt', 'attemptKey', 'logicalJobKey', 'role', 'streamID', 'mode', 'requestType', 'requestKey']) if (!nonempty(row?.[field])) throw new Error(`invalid attempt ${field}`);
  strictIso(row.createdAt, 'createdAt'); strictIso(row.updatedAt, 'updatedAt');
  if (row.requestKey !== request.requestKey || row.requestType !== request.requestType || !expected.includes(row.logicalJobKey)) throw new Error('attempt request linkage mismatch');
  if (!Number.isInteger(row.attempt) || row.attempt < 1 || row.attemptKey !== `${row.logicalJobKey}:${row.attempt}`) throw new Error('invalid attempt identity');
  if (!['pending', 'canonical', 'duplicate'].includes(row.reconciliationStatus)) throw new Error('invalid attempt reconciliation');
  if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== String(row.id)) throw new Error('canonical attempt self-link mismatch');
  if (row.reconciliationStatus === 'pending' && (row.canonicalRowID || '') !== '') throw new Error('pending attempt must have empty canonical link');
  if (row.reconciliationStatus === 'duplicate' && !nonempty(row.canonicalRowID)) throw new Error('duplicate attempt linkage missing');
  const stream = streams.find((candidate) => logicalKey(request, candidate) === row.logicalJobKey);
  if (!stream || row.role !== stream.role || row.streamID !== String(stream.liveStreamID) || row.mode !== stream.mode) throw new Error('attempt immutable context mismatch');
  const context = json(row.streamContextJson, 'streamContextJson', (value) => value && !Array.isArray(value));
  if (JSON.stringify(context) !== JSON.stringify(stream.streamContext)) throw new Error('attempt stream context mismatch');
}
function retryTarget(row, attempts) {
  const resolution = row.manualReviewResolution || '';
  const match = /^retry_created:(.+):(\d+)$/.exec(resolution);
  if (!match || match[1] !== row.logicalJobKey || Number(match[2]) !== row.attempt + 1) throw new Error('broken retry materialization chain');
  const nextKey = `${row.logicalJobKey}:${row.attempt + 1}`;
  const targets = attempts.filter((candidate) => candidate.attemptKey === nextKey && candidate.reconciliationStatus === 'canonical');
  if (targets.length !== 1 || targets[0].attempt !== row.attempt + 1) throw new Error('broken retry materialization chain');
  return targets[0];
}
function aggregateLogicalJobs(request, rows) {
  validateRequestRows([request], request.requestKey);
  const { streams, expected, existing } = requestImmutables(request);
  if (!Array.isArray(rows)) throw new Error('attempt rows must be an array');
  const grouped = new Map();
  for (const row of rows.filter((candidate) => candidate && Object.hasOwn(candidate, 'id'))) {
    validateAttempt(row, request, expected, streams);
    const group = grouped.get(row.attemptKey) || [];
    group.push(row); grouped.set(row.attemptKey, group);
  }
  const canonicalByLogical = new Map();
  for (const group of grouped.values()) {
    const canonical = group.filter((row) => row.reconciliationStatus === 'canonical');
    if (canonical.length !== 1) throw new Error('attempt key must have exactly one canonical');
    if (group.some((row) => row.reconciliationStatus === 'duplicate' && row.canonicalRowID !== String(canonical[0].id))) throw new Error('attempt duplicate canonical linkage mismatch');
    const list = canonicalByLogical.get(canonical[0].logicalJobKey) || [];
    list.push(canonical[0]); canonicalByLogical.set(canonical[0].logicalJobKey, list);
  }
  const available = new Map(); const failed = []; const unresolved = [];
  for (const stream of streams) {
    const key = logicalKey(request, stream);
    const persisted = existing[stream.role];
    if (persisted) { available.set(key, { stream, dialogue: persisted.dialogue }); continue; }
    const attempts = canonicalByLogical.get(key) || [];
    if (!attempts.length) throw new Error('missing canonical attempt');
    const successes = attempts.filter((row) => row.status === 'completed');
    if (successes.length) { available.set(key, { stream, dialogue: [...successes].sort((a, b) => a.attempt - b.attempt || compareRows(a, b))[0].dialogue }); continue; }
    const retryRows = attempts.filter((row) => row.status === 'retry_materialized' || (row.status === 'manual_review' && nonempty(row.manualReviewResolution)));
    retryRows.forEach((row) => retryTarget(row, attempts));
    const activeAttempts = attempts.filter((row) => !retryRows.includes(row));
    if (activeAttempts.some((row) => PENDING.has(row.status) || (row.status === 'manual_review' && !nonempty(row.manualReviewResolution)))) { unresolved.push(key); continue; }
    if (activeAttempts.length && activeAttempts.every((row) => TERMINAL.has(row.status))) { failed.push(key); continue; }
    throw new Error('unsupported attempt status');
  }
  if (unresolved.length) return { action: 'pending', status: 'waiting_stt', unresolvedLogicalJobKeys: unresolved };
  const resolved = streams.filter((stream) => available.has(logicalKey(request, stream)));
  const coverageStatus = resolved.length === streams.length ? 'complete' : resolved.length ? 'partial' : 'all_failed';
  return { action: coverageStatus === 'all_failed' ? 'all_failed' : 'ready', coverageStatus, availableRoles: resolved.map((stream) => stream.role), missingRoles: streams.filter((stream) => !resolved.includes(stream)).map((stream) => stream.role), failedLogicalJobKeys: failed, streams: resolved.map((stream) => ({ ...stream, dialogue: available.get(logicalKey(request, stream)).dialogue })) };
}

function preflightAI(requestRows, attemptRows, requestKey, owner, nowIso) {
  const reconciliation = planRequestReconciliation(requestRows, requestKey);
  if (reconciliation.action !== 'ready') return { action: reconciliation.action, mutations: reconciliation.mutations };
  const request = reconciliation.canonical;
  if (request.status !== 'summary_dispatching' || request.leaseOwner !== owner || !request.leaseUntilIso || strictIso(request.leaseUntilIso, 'lease expiry') <= strictIso(nowIso, 'current time')) throw new Error('pre-AI owner gate failed');
  const aggregate = aggregateLogicalJobs(request, attemptRows);
  if (!['complete', 'partial'].includes(aggregate.coverageStatus)) throw new Error('pre-AI coverage is not usable');
  const expected = {
    coverageStatus: aggregate.coverageStatus,
    availableRolesJson: JSON.stringify(aggregate.availableRoles),
    missingRolesJson: JSON.stringify(aggregate.missingRoles),
    failedLogicalJobKeysJson: JSON.stringify(aggregate.failedLogicalJobKeys),
  };
  for (const [field, value] of Object.entries(expected)) if (request[field] !== value) throw new Error(`pre-AI persisted coverage mismatch: ${field}`);
  return { ...request, ...aggregate, action: 'ai' };
}
function runPreflightRuntime(requestRows, attemptRows, requestKey, owner, nowIso) {
  const result = preflightAI(requestRows, attemptRows, requestKey, owner, nowIso);
  if (result.action === 'ready' || result.action === 'reconcile' || result.action === 'manual_review') return result.mutations.map((mutation) => ({ ...mutation, action: result.action }));
  return [result];
}
if (typeof module !== 'undefined' && module.exports) module.exports = { preflightAI, runPreflightRuntime };
if (typeof $input !== 'undefined') {
  const requestRows = $('Re-read Request Before AI').all().map(({ json: row }) => row).filter((row) => row && Object.hasOwn(row, 'id'));
  const requestKey = $('Start').first().json.requestKey;
  return runPreflightRuntime(requestRows, $input.all().map(({ json: row }) => row).filter((row) => row && Object.hasOwn(row, 'id')), requestKey, $execution.id, new Date().toISOString()).map((json) => ({ json }));
}
