const PENDING = new Set(['queued', 'dispatching', 'waiting_callback', 'retry_pending', 'retry_materializing']);
const TERMINAL = new Set(['failed', 'timed_out']);
const REQUEST_STAGES = new Set(['ready', 'summary_dispatching', 'summary_retry_pending', 'completed']);
const CHECKPOINTS = ['inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS'];
const RESOLUTION_EPOCH_ISO = '1970-01-01T00:00:00.000Z';

function nonempty(value) { return typeof value === 'string' && value.trim() !== ''; }
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
function checkpointVector(row) { return CHECKPOINTS.map((key) => row[key] || ''); }
function hasCheckpoint(row) { return checkpointVector(row).some(nonempty); }
function sameVector(left, right) { return checkpointVector(left).every((value, index) => value === checkpointVector(right)[index]); }
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
    if (!row || row.requestKey !== requestKey || !nonempty(row.id) || !nonempty(row.requestType)) throw new Error('invalid request system fields or key');
    strictIso(row.createdAt, 'createdAt'); strictIso(row.updatedAt, 'updatedAt');
    if (!['pending', 'canonical', 'duplicate'].includes(row.reconciliationStatus)) throw new Error('invalid request reconciliation status');
    if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== row.id) throw new Error('canonical request self-link mismatch');
    if (row.reconciliationStatus === 'pending' && (row.canonicalRowID || '') !== '') throw new Error('pending request must have empty canonical link');
    if (row.reconciliationStatus === 'duplicate' && !nonempty(row.canonicalRowID)) throw new Error('duplicate request must link to canonical');
    requestImmutables(row);
    const immutable = [row.requestType, row.orderedStreamsJson, row.existingDialoguesJson, row.expectedLogicalJobKeysJson, row.channel, row.threadTS].join('\u0000');
    if (baseline !== undefined && baseline !== immutable) throw new Error('request immutable replay mismatch');
    baseline = immutable;
  }
}
function reconcileMutation(row, winnerRowID, desired) {
  return { id: row.id, requestKey: row.requestKey, expectedStatus: row.status, expectedReconciliationStatus: row.reconciliationStatus, expectedCanonicalRowID: row.canonicalRowID || '', expectedUpdatedAt: row.updatedAt, desiredReconciliationStatus: desired, desiredCanonicalRowID: winnerRowID };
}
function planRequestReconciliation(rows, requestKey) {
  validateRequestRows(rows, requestKey);
  const canonicals = rows.filter((row) => row.reconciliationStatus === 'canonical');
  if (canonicals.length > 1 && rows.some(hasCheckpoint)) {
    return { action: 'manual_review', reason: 'multiple_canonical_checkpoint_conflict', mutations: canonicals.map((row) => {
      if (!REQUEST_STAGES.has(row.status)) throw new Error('checkpoint conflict has invalid original stage');
      return { id: row.id, requestKey, expectedStatus: row.status, expectedReconciliationStatus: 'canonical', expectedCanonicalRowID: row.id, expectedUpdatedAt: row.updatedAt, manualReviewOriginalStage: row.status };
    }) };
  }
  const winner = canonicals.length ? [...canonicals].sort(compareRows)[0] : [...rows].sort(compareRows)[0];
  const mutations = rows.filter((row) => row.id !== winner.id || row.reconciliationStatus !== 'canonical' || row.canonicalRowID !== winner.id).map((row) => reconcileMutation(row, winner.id, row.id === winner.id ? 'canonical' : 'duplicate'));
  return mutations.length ? { action: 'reconcile', winnerRowID: winner.id, mutations } : { action: 'ready', winnerRowID: winner.id, canonical: winner };
}
function verifyRequestReconciliation(rows, plan) {
  validateRequestRows(rows, plan.requestKey || rows[0]?.requestKey);
  const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === row.id);
  if (canonical.length !== 1 || canonical[0].id !== plan.winnerRowID) throw new Error('request reconciliation verification failed');
  if (rows.some((row) => row.id !== canonical[0].id && (row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== canonical[0].id))) throw new Error('request reconciliation losers mismatch');
  return canonical[0];
}

function validateAttempt(row, request, expected, streams) {
  for (const field of ['id', 'createdAt', 'updatedAt', 'attemptKey', 'logicalJobKey', 'role', 'streamID', 'mode', 'requestType', 'requestKey']) if (!nonempty(row?.[field])) throw new Error(`invalid attempt ${field}`);
  strictIso(row.createdAt, 'createdAt'); strictIso(row.updatedAt, 'updatedAt');
  if (row.requestKey !== request.requestKey || row.requestType !== request.requestType || !expected.includes(row.logicalJobKey)) throw new Error('attempt request linkage mismatch');
  if (!Number.isInteger(row.attempt) || row.attempt < 1 || row.attemptKey !== `${row.logicalJobKey}:${row.attempt}`) throw new Error('invalid attempt identity');
  if (!['pending', 'canonical', 'duplicate'].includes(row.reconciliationStatus)) throw new Error('invalid attempt reconciliation');
  if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== row.id) throw new Error('canonical attempt self-link mismatch');
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
  const target = targets[0];
  return target;
}
function aggregateLogicalJobs(request, rows) {
  validateRequestRows([request], request.requestKey);
  const { streams, expected, existing } = requestImmutables(request);
  if (!Array.isArray(rows)) throw new Error('attempt rows must be an array');
  const grouped = new Map();
  for (const row of rows.filter((candidate) => candidate?.id)) {
    validateAttempt(row, request, expected, streams);
    const group = grouped.get(row.attemptKey) || [];
    group.push(row); grouped.set(row.attemptKey, group);
  }
  const canonicalByLogical = new Map();
  for (const group of grouped.values()) {
    const canonical = group.filter((row) => row.reconciliationStatus === 'canonical');
    if (canonical.length !== 1) throw new Error('attempt key must have exactly one canonical');
    if (group.some((row) => row.reconciliationStatus === 'duplicate' && row.canonicalRowID !== canonical[0].id)) throw new Error('attempt duplicate canonical linkage mismatch');
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
    const successes = attempts.filter((row) => row.status === 'completed' && nonempty(row.dialogue));
    if (successes.length) { available.set(key, { stream, dialogue: [...successes].sort((a, b) => a.attempt - b.attempt || compareRows(a, b))[0].dialogue }); continue; }
    const retryRows = attempts.filter((row) => row.status === 'retry_materialized' || (row.status === 'manual_review' && nonempty(row.manualReviewResolution)));
    retryRows.forEach((row) => retryTarget(row, attempts));
    if (attempts.some((row) => PENDING.has(row.status) || row.status === 'retry_materialized' || (row.status === 'manual_review' && !nonempty(row.manualReviewResolution)))) { unresolved.push(key); continue; }
    if (attempts.every((row) => TERMINAL.has(row.status))) { failed.push(key); continue; }
    throw new Error('unsupported attempt status');
  }
  if (unresolved.length) return { action: 'pending', status: 'waiting_stt', unresolvedLogicalJobKeys: unresolved };
  const resolved = streams.filter((stream) => available.has(logicalKey(request, stream)));
  const coverageStatus = resolved.length === streams.length ? 'complete' : resolved.length ? 'partial' : 'all_failed';
  return { action: coverageStatus === 'all_failed' ? 'all_failed' : 'ready', coverageStatus, availableRoles: resolved.map((stream) => stream.role), missingRoles: streams.filter((stream) => !resolved.includes(stream)).map((stream) => stream.role), failedLogicalJobKeys: failed, streams: resolved.map((stream) => ({ ...stream, dialogue: available.get(logicalKey(request, stream)).dialogue })) };
}

function planRequestResolution(rows, approval) {
  validateRequestRows(rows, rows[0]?.requestKey);
  if (!approval?.approved || !nonempty(approval.approvalRef)) throw new Error('production approval reference required');
  const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical');
  if (!canonical.length) throw new Error('resolution requires canonical rows');
  const fixed = canonical.find((row) => nonempty(row.manualResolutionDecisionID) || nonempty(row.manualResolutionWinnerRowID));
  if (fixed && (!nonempty(fixed.manualResolutionDecisionID) || !nonempty(fixed.manualResolutionWinnerRowID))) throw new Error('incomplete immutable resolution decision');
  if (fixed && (approval.decisionID && approval.decisionID !== fixed.manualResolutionDecisionID || approval.winnerRowID && approval.winnerRowID !== fixed.manualResolutionWinnerRowID)) throw new Error('resolution decision is immutable');
  const checkpoints = canonical.filter(hasCheckpoint);
  let winner;
  let selectionReason;
  if (fixed) { winner = rows.find((row) => row.id === fixed.manualResolutionWinnerRowID); if (!winner) throw new Error('fixed resolution winner missing'); }
  else if (approval.decision === 'failed') { winner = [...canonical].sort(compareRows)[0]; selectionReason = 'explicit_request_failure'; }
  else if (checkpoints.length === 1) { winner = checkpoints[0]; selectionReason = 'only_checkpoint'; }
  else if (checkpoints.length > 1 && checkpoints.every((row) => sameVector(row, checkpoints[0]))) { winner = [...checkpoints].sort(compareRows)[0]; selectionReason = 'identical_checkpoints_system_earliest'; }
  else if (nonempty(approval.winnerRowID) && canonical.some((row) => row.id === approval.winnerRowID)) { winner = canonical.find((row) => row.id === approval.winnerRowID); selectionReason = 'explicit_checkpoint_winner'; }
  else throw new Error('conflicting checkpoints need explicit winner');
  if (!REQUEST_STAGES.has(winner.manualReviewOriginalStage)) throw new Error('invalid manual review original stage');
  const decisionID = fixed ? fixed.manualResolutionDecisionID : approval.decisionID;
  if (!nonempty(decisionID)) throw new Error('resolution decision ID required');
  const failed = approval.decision === 'failed';
  if (!fixed) return { action: 'persist_decision', winnerRowID: winner.id, decisionID, resumeStatus: winner.manualReviewOriginalStage, selectionReason, failed, createsSttAttempt: false, expected: { status: 'manual_review', reconciliationStatus: 'canonical', canonicalRowID: winner.id, manualResolutionDecisionID: '', manualResolutionWinnerRowID: '' } };
  const losers = rows.filter((row) => row.id !== winner.id);
  const pending = losers.filter((row) => !(row.reconciliationStatus === 'duplicate' && row.canonicalRowID === winner.id && row.manualResolutionDecisionID === decisionID));
  if (pending.length) return { action: 'patch_losers', winnerRowID: winner.id, decisionID, resumeStatus: winner.manualReviewOriginalStage, createsSttAttempt: false, mutations: pending.sort(compareRows).map((row) => ({ id: row.id, requestKey: row.requestKey, expectedStatus: row.status, expectedReconciliationStatus: row.reconciliationStatus, expectedCanonicalRowID: row.canonicalRowID || '', expectedUpdatedAt: row.updatedAt, desiredReconciliationStatus: 'duplicate', desiredCanonicalRowID: winner.id, manualResolutionDecisionID: decisionID })) };
  return { action: 'finalize', winnerRowID: winner.id, decisionID, resumeStatus: failed ? 'failed' : winner.manualReviewOriginalStage, failed, createsSttAttempt: false, expected: { status: 'manual_review', reconciliationStatus: 'canonical', canonicalRowID: winner.id, manualResolutionDecisionID: decisionID, manualResolutionWinnerRowID: winner.id }, manualReviewResolution: failed ? 'request_failed:checkpoint_conflict' : `winner_selected:${winner.id}:resume:${winner.manualReviewOriginalStage}` };
}

function runRequestResolution(rows, approval, options = {}) {
  const next = rows.map((row) => ({ ...row })); let sideEffectCalls = 0; let reElected = false;
  for (;;) {
    const plan = planRequestResolution(next, approval);
    if (plan.action === 'persist_decision') {
      const winner = next.find((row) => row.id === plan.winnerRowID); winner.manualResolutionDecisionID = plan.decisionID; winner.manualResolutionWinnerRowID = winner.id; continue;
    }
    if (plan.action === 'patch_losers') {
      for (const mutation of plan.mutations) {
        if (options.failLoserID === mutation.id) return { rows: next, winner: next.find((row) => row.id === plan.winnerRowID), losers: next.filter((row) => row.id !== plan.winnerRowID), canonicalRows: next.filter((row) => row.reconciliationStatus === 'canonical'), sideEffectCalls, sideEffectCallsBeforeFinalPatch: sideEffectCalls, reElected };
        const row = next.find((candidate) => candidate.id === mutation.id); row.reconciliationStatus = 'duplicate'; row.canonicalRowID = plan.winnerRowID; row.manualResolutionDecisionID = plan.decisionID;
      }
      continue;
    }
    if (options.crashBeforeWinnerFinalPatch) return { rows: next, winner: next.find((row) => row.id === plan.winnerRowID), losers: next.filter((row) => row.id !== plan.winnerRowID), canonicalRows: next.filter((row) => row.reconciliationStatus === 'canonical'), sideEffectCalls, reElected };
    const winner = next.find((row) => row.id === plan.winnerRowID); winner.status = plan.resumeStatus; winner.manualReviewResolution = plan.manualReviewResolution;
    if (winner.status === 'ready') { winner.leaseOwner = ''; winner.leaseUntilIso = ''; }
    if (winner.status === 'summary_dispatching') { winner.leaseOwner = ''; winner.leaseUntilIso = options.resolutionIso || RESOLUTION_EPOCH_ISO; }
    if (winner.status === 'summary_retry_pending') { winner.leaseOwner = ''; winner.leaseUntilIso = ''; }
    return { rows: next, winner, losers: next.filter((row) => row.id !== winner.id), canonicalRows: next.filter((row) => row.reconciliationStatus === 'canonical'), sideEffectCalls, sideEffectCallsBeforeFinalPatch: sideEffectCalls, reElected };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { aggregateLogicalJobs, compareRows, nonempty, planRequestReconciliation, planRequestResolution, requestImmutables, runRequestResolution, strictIso, validateRequestRows, verifyRequestReconciliation };
if (typeof $input !== 'undefined') {
  const requestRows = $('Read All Request Rows').all().map(({ json: row }) => row).filter((row) => row.id);
  const requestKey = $('Start').first().json.requestKey;
  const reconciliation = planRequestReconciliation(requestRows, requestKey);
  if (reconciliation.action !== 'ready') return reconciliation.mutations.map((row) => ({ json: { ...row, action: reconciliation.action } }));
  return [{ json: { ...reconciliation.canonical, ...aggregateLogicalJobs(reconciliation.canonical, $input.all().map(({ json: row }) => row).filter((row) => row.id)) } }];
}
