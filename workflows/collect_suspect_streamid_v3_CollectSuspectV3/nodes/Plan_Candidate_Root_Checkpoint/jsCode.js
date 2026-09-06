const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d{6}$/;
const CLAIM_PREFIX = 'root_claim|';
const CLAIM_MS = 5 * 60 * 1000;

function requireCanonical(row) {
  if (!Number.isSafeInteger(row?.id) || row.id <= 0 || row.reconciliationStatus !== 'canonical' || row.canonicalRowID !== String(row.id)) {
    throw new Error('Candidate root ownership requires one canonical self-linked row');
  }
  return row;
}

function parseClaim(value) {
  if (typeof value !== 'string' || !value.startsWith(CLAIM_PREFIX)) return null;
  const parts = value.split('|');
  if (parts.length !== 3 || !parts[1] || !Number.isFinite(Date.parse(parts[2]))) return null;
  return { owner: parts[1], untilIso: parts[2] };
}

function planRootOwnership(row, owner, nowIso) {
  const canonical = requireCanonical(row);
  const nowMs = Date.parse(nowIso);
  if (!owner || !Number.isFinite(nowMs)) throw new Error('Root owner and current time are required');
  if (SLACK_TIMESTAMP_PATTERN.test(canonical.threadTS || '')) return { ...canonical, action: 'ready' };
  const existing = canonical.threadTS || '';
  const claim = parseClaim(existing);
  if (existing && !claim) throw new Error('Candidate root checkpoint is malformed');
  if (claim && Date.parse(claim.untilIso) > nowMs) return { ...canonical, action: 'blocked' };
  const desiredThreadTS = `${CLAIM_PREFIX}${owner}|${new Date(nowMs + CLAIM_MS).toISOString()}`;
  return {
    action: 'claim',
    phase: 'claim',
    id: canonical.id,
    candidateKey: canonical.candidateKey,
    expectedThreadTS: existing,
    desiredThreadTS,
    owner,
  };
}

function matchingCanonical(rows, plan) {
  const matches = rows.filter((row) => row?.id === plan.id
    && row.candidateKey === plan.candidateKey
    && row.reconciliationStatus === 'canonical'
    && row.canonicalRowID === String(row.id));
  if (matches.length !== 1) throw new Error('Candidate root canonical row is missing or ambiguous');
  return matches[0];
}

function verifyRootClaim(plan, rows) {
  const canonical = matchingCanonical(rows, plan);
  if (canonical.threadTS !== plan.desiredThreadTS) throw new Error('Candidate root claim CAS was not persisted');
  return { ...canonical, action: 'owned', rootClaimToken: plan.desiredThreadTS, rootClaimVerified: true };
}

function buildRootCheckpointPlans(owners, slackRows) {
  if (owners.length !== slackRows.length) throw new Error('Candidate root Slack output count mismatch');
  return owners.map((owner, index) => {
    if (owner.rootClaimVerified !== true || !parseClaim(owner.rootClaimToken)) throw new Error('Candidate root owner is not verified');
    const desiredThreadTS = slackRows[index]?.message?.ts;
    if (!SLACK_TIMESTAMP_PATTERN.test(desiredThreadTS || '')) throw new Error('Candidate root Slack timestamp is invalid');
    return {
      action: 'checkpoint',
      phase: 'checkpoint',
      id: owner.id,
      candidateKey: owner.candidateKey,
      expectedThreadTS: owner.rootClaimToken,
      desiredThreadTS,
    };
  });
}

function verifyRootCheckpoint(plan, rows) {
  const canonical = matchingCanonical(rows, plan);
  if (!SLACK_TIMESTAMP_PATTERN.test(canonical.threadTS || '') || canonical.threadTS !== plan.desiredThreadTS) {
    throw new Error('Candidate root checkpoint CAS was not persisted');
  }
  return { ...canonical, action: 'ready' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildRootCheckpointPlans,
    parseClaim,
    planRootOwnership,
    verifyRootCheckpoint,
    verifyRootClaim,
  };
}

if (typeof $input !== 'undefined') {
  const values = $input.all().map(({ json }) => json).filter(Boolean);
  const rows = values.filter(({ createdAt, id }) => createdAt && id);
  const checkpointPlans = values.filter(({ phase }) => phase === 'checkpoint');
  if (checkpointPlans.length) return checkpointPlans.map((plan) => ({ json: verifyRootCheckpoint(plan, rows) }));
  const messages = values.filter(({ message }) => message?.ts !== undefined);
  const owners = values.filter(({ rootClaimVerified }) => rootClaimVerified === true);
  if (messages.length || owners.length) return buildRootCheckpointPlans(owners, messages).map((json) => ({ json }));
  const claimPlans = values.filter(({ phase }) => phase === 'claim');
  if (claimPlans.length) return claimPlans.map((plan) => ({ json: verifyRootClaim(plan, rows) }));
  const owner = typeof $execution !== 'undefined' ? String($execution.id) : 'manual';
  return values.filter(({ action }) => action === 'ready')
    .map((row) => ({ json: planRootOwnership(row, owner, new Date().toISOString()) }));
}
