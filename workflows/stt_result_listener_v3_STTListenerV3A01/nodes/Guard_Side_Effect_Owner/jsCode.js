const logicalRows = $input.all().map((item) => item.json).filter((row) => row && Object.keys(row).length);
const summaries = $('Read Summary Before Side Effect').all().map((item) => item.json).filter((row) => row && Object.keys(row).length);
const claim = $('Claim Presentation').first().json;
const terminal = new Set(['completed', 'failed', 'timed_out']);
const immutable = ['logicalJobKey', 'requestKey', 'requestType', 'role', 'streamID', 'mode', 'channel', 'threadTS', 'processingMessageTS'];
if (!logicalRows.length || logicalRows.some((row) => immutable.some((field) => row[field] !== claim[field]))) {
  throw new Error('Logical side-effect provenance mismatch');
}
const attempts = logicalRows.filter((row) => row.attemptKey === claim.attemptKey);
const ALLOWED_CHANNELS = new Set(['C0A4JJJKJMD', 'C09F0SYG57D']);
if (!attempts.length) throw new Error('Attempt row not found before side effect');
const { attemptKey, requestKey } = attempts[0];
for (const row of attempts) {
  if (!row.id || !row.createdAt || !row.updatedAt || row.attemptKey !== attemptKey || row.requestKey !== requestKey) throw new Error('Invalid same-attempt rows before side effect');
  if (!['pending', 'canonical', 'duplicate'].includes(row.reconciliationStatus)) throw new Error('Invalid reconciliation status before side effect');
  if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== String(row.id)) throw new Error('Invalid canonical linkage before side effect');
  if (row.reconciliationStatus === 'pending' && row.canonicalRowID !== '') throw new Error('Invalid pending linkage before side effect');
  if (row.reconciliationStatus === 'duplicate' && !row.canonicalRowID) throw new Error('Invalid duplicate linkage before side effect');
}
if (summaries.some((row) => row.requestKey !== requestKey)) throw new Error('Summary requestKey mismatch');
const attemptCheckpoints = ['submittedAtIso', 'callbackDeadlineAtIso', 'consumedAtIso', 'dialogue', 'transcriptUploadID', 'analysisUploadID', 'processingMessageUpdatedAtIso'];
const summaryCheckpoints = ['inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS'];
const present = (value) => value !== undefined && value !== null && value !== '';
const strictIso = (value) => typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const canonical = attempts.filter((row) => row.reconciliationStatus === 'canonical');
if (canonical.length === 1) {
  const winner = canonical[0];
  const staleRows = attempts.filter((row) => row.id !== winner.id && (row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(winner.id)));
  if (staleRows.length) {
    return staleRows.map((row) => ({ json: {
      id: row.id, attemptKey: row.attemptKey, expectedStatus: row.status,
      expectedReconciliationStatus: row.reconciliationStatus, expectedCanonicalRowID: row.canonicalRowID || '',
      desiredReconciliationStatus: 'duplicate', desiredCanonicalRowID: String(winner.id),
      reconciliationAction: 'reconcile',
    } }));
  }
}
if (canonical.length !== 1) {
  if (canonical.length > 1 && (attempts.some((row) => attemptCheckpoints.some((field) => present(row[field]))) || summaries.some((row) => summaryCheckpoints.some((field) => present(row[field]))))) {
    return canonical.map((row) => ({ json: {
      id: row.id, attemptKey: row.attemptKey, expectedStatus: row.status,
      expectedReconciliationStatus: 'canonical', expectedCanonicalRowID: String(row.id),
      desiredReconciliationStatus: 'canonical', desiredCanonicalRowID: String(row.id),
      reconciliationAction: 'manual_review',
    } }));
  }
  const sorted = [...canonical.length ? canonical : attempts].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const winner = sorted[0];
  return attempts.filter((row) => row.id !== winner.id || row.reconciliationStatus !== 'canonical').map((row) => ({ json: {
    id: row.id, attemptKey: row.attemptKey, expectedStatus: row.status,
    expectedReconciliationStatus: row.reconciliationStatus, expectedCanonicalRowID: row.canonicalRowID || '',
    desiredReconciliationStatus: row.id === winner.id ? 'canonical' : 'duplicate', desiredCanonicalRowID: String(winner.id),
    reconciliationAction: 'reconcile',
  } }));
}
const row = canonical[0];
const groupsByAttempt = new Map();
for (const candidate of logicalRows) {
  if (!Number.isSafeInteger(candidate.id) || candidate.id <= 0 || !Number.isInteger(candidate.attempt) || candidate.attempt < 1) {
    throw new Error('Invalid logical side-effect identity');
  }
  if (!strictIso(candidate.createdAt) || !strictIso(candidate.updatedAt) || !['canonical', 'duplicate'].includes(candidate.reconciliationStatus)) {
    throw new Error('Invalid logical side-effect row');
  }
  if (candidate.reconciliationStatus === 'canonical' && candidate.canonicalRowID !== String(candidate.id)) throw new Error('Malformed logical canonical linkage');
  if (candidate.reconciliationStatus === 'duplicate' && (typeof candidate.canonicalRowID !== 'string' || !candidate.canonicalRowID)) throw new Error('Malformed logical duplicate linkage');
  if (candidate.status === 'completed' && !strictIso(candidate.consumedAtIso)) throw new Error('Completed logical row requires consumedAtIso');
  const group = groupsByAttempt.get(candidate.attemptKey) || [];
  group.push(candidate);
  groupsByAttempt.set(candidate.attemptKey, group);
}
const canonicalByAttempt = new Map();
for (const [attemptKey, group] of groupsByAttempt) {
  const canonicalRows = group.filter((candidate) => candidate.reconciliationStatus === 'canonical');
  if (canonicalRows.length !== 1) throw new Error('Logical side-effect requires one self-linked canonical');
  const winner = canonicalRows[0];
  if (group.some((candidate) => candidate.reconciliationStatus === 'duplicate' && candidate.canonicalRowID !== String(winner.id))) {
    throw new Error('Logical duplicate does not link to its canonical');
  }
  canonicalByAttempt.set(attemptKey, winner);
}
const current = canonicalByAttempt.get(claim.attemptKey);
if (!current || current.id !== claim.id || current.status !== claim.status || current.presentationStatus !== 'presenting') {
  throw new Error('Logical side-effect current owner changed');
}
const canonicalRows = [...canonicalByAttempt.values()];
const completed = canonicalRows.filter((candidate) => candidate.status === 'completed');
if (completed.length) {
  const winner = [...completed].sort((left, right) => left.consumedAtIso.localeCompare(right.consumedAtIso) || left.id - right.id)[0];
  if (winner.id !== current.id) throw new Error('Logical completed winner supersedes side effect');
} else if (canonicalRows.some((candidate) => candidate.attempt > current.attempt && !terminal.has(candidate.status))) {
  throw new Error('Newer logical attempt blocks side effect');
} else if (current.status !== 'completed' && current.attempt !== Math.max(...canonicalRows.filter((candidate) => terminal.has(candidate.status)).map((candidate) => candidate.attempt))) {
  throw new Error('Older terminal attempt blocks side effect');
}
const now = new Date().toISOString();
if (row.canonicalRowID !== String(row.id) || !['completed', 'failed', 'timed_out'].includes(row.status)) throw new Error('Invalid canonical owner state');
if (row.id !== $('Claim Presentation').first().json.id) throw new Error('Claimed canonical ID changed');
if (row.presentationStatus !== 'presenting' || row.presentationLeaseOwner !== $execution.id || row.presentationLeaseOwner !== claim.presentationLeaseOwner) throw new Error('Presentation owner mismatch');
if (row.presentationAttempt !== claim.presentationAttempt || row.presentationLeaseUntilIso !== claim.presentationLeaseUntilIso) throw new Error('Presentation claim snapshot mismatch');
if (!row.presentationLeaseUntilIso || Date.parse(row.presentationLeaseUntilIso) <= Date.parse(now) || new Date(Date.parse(row.presentationLeaseUntilIso)).toISOString() !== row.presentationLeaseUntilIso) throw new Error('Presentation lease expired');
if (!ALLOWED_CHANNELS.has(row.channel)) throw new Error('Invalid presentation channel');
const messageOnly = row.status !== 'completed' || !String(row.dialogue || '').trim();
const stage = messageOnly
  ? (!row.processingMessageUpdatedAtIso ? 'message_update' : 'complete')
  : (!row.transcriptUploadID ? 'transcript' : !row.analysisUploadID ? 'analysis' : !row.processingMessageUpdatedAtIso ? 'message_update' : 'complete');
return [{ json: { ...row, presentationMode: messageOnly ? 'message_only' : 'full', presentationStage: stage, dispatchRoute: stage, reconciliationAction: 'ready' } }];
