const CHANNEL = 'C0A4JJJKJMD';
const STREAM_ID_PATTERN = /^[0-9]{1,20}$/;

function systemRowID(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function requiredStreamID(value, fieldName) {
  const normalized = String(value ?? '').trim();
  if (!STREAM_ID_PATTERN.test(normalized)) throw new Error(`${fieldName} must be a numeric stream ID`);
  return normalized;
}

function deduplicateCandidates(rows, { runID, nowIso } = {}) {
  const executionID = String(runID ?? '').trim();
  const timestamp = String(nowIso ?? '').trim();
  if (!executionID || !timestamp) throw new Error('runID and nowIso are required');
  const candidates = new Map();
  for (const row of rows || []) {
    if (!row || !row.streamID) continue;
    const streamID = requiredStreamID(row.streamID, 'streamID');
    const prevStreamID = row.prevStreamID ? requiredStreamID(row.prevStreamID, 'prevStreamID') : '';
    const candidateKey = `suspect:${executionID}:${prevStreamID || 'none'}:${streamID}`;
    const source = String(row.metricSource || row.metric_source || 'unknown').trim();
    if (!candidates.has(candidateKey)) {
      candidates.set(candidateKey, {
        candidateKey,
        runID: executionID,
        streamID,
        prevStreamID,
        userID: String(row.userID ?? '').trim(),
        sources: [],
      });
    }
    const candidate = candidates.get(candidateKey);
    if (source && !candidate.sources.includes(source)) candidate.sources.push(source);
  }
  return [...candidates.values()].map((candidate) => ({
    candidateKey: candidate.candidateKey,
    runID: candidate.runID,
    streamID: candidate.streamID,
    prevStreamID: candidate.prevStreamID,
    sourcesJson: JSON.stringify(candidate.sources.sort()),
    channel: CHANNEL,
    threadTS: '',
    summaryRequestKey: `suspect-summary:${candidate.candidateKey}`,
    reconciliationStatus: 'pending',
    canonicalRowID: '',
    createdAtIso: timestamp,
    updatedAtIso: timestamp,
  }));
}

function compareSystemOrder(left, right) {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function planCandidateReconciliation(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('candidate rows are required');
  const candidateKey = rows[0].candidateKey;
  for (const row of rows) {
    if (!systemRowID(row.id) || !row.createdAt || row.candidateKey !== candidateKey) throw new Error('invalid candidate reconciliation row');
    if (!['pending', 'canonical', 'duplicate'].includes(row.reconciliationStatus)) throw new Error('invalid candidate reconciliation status');
  }
  const canonicals = rows.filter(({ reconciliationStatus }) => reconciliationStatus === 'canonical');
  if (canonicals.length > 1 && canonicals.some(({ threadTS }) => threadTS)) {
    throw new Error('multiple candidate canonicals have a persisted Slack checkpoint');
  }
  const winner = [...(canonicals.length ? canonicals : rows)].sort(compareSystemOrder)[0];
  const mutations = rows
    .filter((row) => row.id === winner.id
      ? row.reconciliationStatus !== 'canonical' || row.canonicalRowID !== String(row.id)
      : row.reconciliationStatus !== 'duplicate' || row.canonicalRowID !== String(winner.id))
    .map((row) => ({
      id: row.id,
      candidateKey,
      expectedReconciliationStatus: row.reconciliationStatus,
      expectedCanonicalRowID: row.canonicalRowID || '',
      desiredReconciliationStatus: row.id === winner.id ? 'canonical' : 'duplicate',
      desiredCanonicalRowID: String(row.id === winner.id ? row.id : winner.id),
    }));
  return { canonical: winner, mutations };
}

function planAllCandidateRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row?.candidateKey) continue;
    if (!grouped.has(row.candidateKey)) grouped.set(row.candidateKey, []);
    grouped.get(row.candidateKey).push(row);
  }
  const output = [];
  for (const candidateRows of grouped.values()) {
    const plan = planCandidateReconciliation(candidateRows);
    if (plan.mutations.length) {
      output.push(...plan.mutations.map((mutation) => ({ ...mutation, action: 'reconcile' })));
    } else {
      output.push({ ...plan.canonical, action: 'ready' });
    }
  }
  return output;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CHANNEL, deduplicateCandidates, planCandidateReconciliation };
}

if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json }) => json).filter(Boolean);
  if (rows.some(({ id }) => id)) {
    return planAllCandidateRows(rows).map((json) => ({ json }));
  }
  const runID = typeof $execution !== 'undefined' ? $execution.id : 'manual';
  return deduplicateCandidates(rows, { runID, nowIso: new Date().toISOString() }).map((json) => ({ json }));
}
