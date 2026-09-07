const TERMINAL = new Set(['completed', 'failed', 'timed_out']);
const IMMUTABLE = ['logicalJobKey', 'requestKey', 'requestType', 'role', 'streamID', 'mode', 'channel', 'threadTS', 'processingMessageTS'];
const CLAIM_SNAPSHOT = ['presentationStatus', 'presentationAttempt', 'presentationLeaseOwner', 'presentationLeaseUntilIso', 'presentationNextRetryAtIso', 'presentationErrorCode'];

function strictIso(value) {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function requireLogicalPresentationWinner(rows, expected) {
  if (!expected || !TERMINAL.has(expected.status)) throw new Error('Invalid expected terminal attempt');
  const meaningful = (Array.isArray(rows) ? rows : []).filter((row) => row && Object.keys(row).length);
  if (!meaningful.length) throw new Error('Logical job rows not found');
  const attempts = new Map();
  for (const row of meaningful) {
    if (IMMUTABLE.some((field) => row[field] !== expected[field])) throw new Error('Logical presentation provenance mismatch');
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || !Number.isInteger(row.attempt) || row.attempt < 1 || typeof row.attemptKey !== 'string' || !row.attemptKey) {
      throw new Error('Invalid logical presentation identity');
    }
    if (!['canonical', 'duplicate'].includes(row.reconciliationStatus)) throw new Error('Unreconciled logical presentation row');
    if (row.reconciliationStatus === 'canonical' && row.canonicalRowID !== String(row.id)) throw new Error('Malformed logical canonical linkage');
    if (row.reconciliationStatus === 'duplicate' && (typeof row.canonicalRowID !== 'string' || !row.canonicalRowID)) throw new Error('Malformed logical duplicate linkage');
    if (row.status === 'completed' && !strictIso(row.consumedAtIso)) throw new Error('Completed logical row requires consumedAtIso');
    const group = attempts.get(row.attemptKey) || [];
    group.push(row);
    attempts.set(row.attemptKey, group);
  }
  const canonicals = [];
  for (const group of attempts.values()) {
    const canonical = group.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
    if (canonical.length !== 1) throw new Error('Logical attempt requires one self-linked canonical');
    if (group.some((row) => row.reconciliationStatus === 'duplicate' && row.canonicalRowID !== String(canonical[0].id))) {
      throw new Error('Logical duplicate does not link to its canonical');
    }
    canonicals.push(canonical[0]);
  }
  const current = canonicals.find((row) => row.id === expected.id && row.attemptKey === expected.attemptKey);
  if (!current || current.status !== expected.status || CLAIM_SNAPSHOT.some((field) => current[field] !== expected[field])) {
    throw new Error('Logical presentation current attempt changed');
  }
  const completed = canonicals.filter((row) => row.status === 'completed');
  if (completed.length) {
    const winner = [...completed].sort((left, right) => (
      left.consumedAtIso.localeCompare(right.consumedAtIso) || left.id - right.id
    ))[0];
    if (winner.id !== current.id) throw new Error('Logical completed winner supersedes presentation');
  } else if (canonicals.some((row) => row.attempt > current.attempt && !TERMINAL.has(row.status))) {
    throw new Error('Newer logical attempt is still active');
  } else if (current.status !== 'completed') {
    const newestTerminal = Math.max(...canonicals.filter((row) => TERMINAL.has(row.status)).map((row) => row.attempt));
    if (current.attempt !== newestTerminal) throw new Error('Older terminal attempt cannot present');
  }
  return {
    ...expected,
    ...current,
    presentationMode: expected.presentationMode,
    expectedPresentationAttempt: expected.expectedPresentationAttempt,
    nextPresentationAttempt: expected.nextPresentationAttempt,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { requireLogicalPresentationWinner };

if (typeof $input !== 'undefined') {
  return [{ json: requireLogicalPresentationWinner($input.all().map(({ json }) => json), $('Require Eligible Canonical').first().json) }];
}
