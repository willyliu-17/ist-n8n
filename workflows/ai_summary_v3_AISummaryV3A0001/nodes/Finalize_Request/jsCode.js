const CHANNEL = 'C0A4JJJKJMD';
const ALLOWED_CHANNELS = new Set([CHANNEL, 'C09F0SYG57D']);
const TS = /^\d{10,}\.\d{6}$/;
const CHECKPOINTS = ['inferenceResultJson', 'summaryMarkdown', 'summaryUploadID', 'summaryMessageTS'];
const TRANSCRIPT_OUTCOMES = new Set(['provided', 'transcribed', 'empty', 'timed_out', 'failed', 'ineligible']);

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function systemRowID(value) { return Number.isInteger(value) && value > 0; }
function json(value, name) {
  try { return JSON.parse(value); } catch { throw new Error(`invalid persisted ${name}`); }
}
function exactArray(actual, expected, name) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name} mismatch`);
}
function validateInput(input) {
  const keys = ['requestKey', 'requestType', 'channel', 'threadTS', 'coverageStatus', 'availableRoles', 'missingRoles', 'failedLogicalJobKeys', 'streams'];
  if (!input || Object.keys(input).length !== keys.length || keys.some((key) => !(key in input))) throw new Error('input must contain exactly nine fields');
  if (!text(input.requestKey) || !text(input.requestType) || !ALLOWED_CHANNELS.has(input.channel) || !TS.test(input.threadTS)) throw new Error('invalid request routing');
  if (!['complete', 'partial'].includes(input.coverageStatus) || !Array.isArray(input.availableRoles) || !Array.isArray(input.missingRoles) || !Array.isArray(input.failedLogicalJobKeys) || !Array.isArray(input.streams) || input.streams.length === 0) throw new Error('invalid resolved coverage');
  const availableRoles = new Set(input.availableRoles);
  const missingRoles = new Set(input.missingRoles);
  if (availableRoles.size !== input.availableRoles.length || missingRoles.size !== input.missingRoles.length
    || [...availableRoles].some((role) => missingRoles.has(role))) throw new Error('invalid role coverage');
  const streamRoles = new Set();
  input.streams.forEach((stream) => {
    const keys = ['role', 'liveStreamID', 'mode', 'dialogue', 'transcript', 'streamContext'];
    if (!stream || Object.keys(stream).length !== keys.length || keys.some((key) => !(key in stream))) throw new Error('invalid resolved stream shape');
    if (!text(stream.role) || !text(stream.liveStreamID) || !['fromStart', 'fromEnd'].includes(stream.mode) || typeof stream.dialogue !== 'string' || !stream.transcript || Array.isArray(stream.transcript) || typeof stream.transcript !== 'object' || !stream.streamContext || Array.isArray(stream.streamContext) || typeof stream.streamContext !== 'object') throw new Error('invalid resolved stream');
    if (Object.keys(stream.transcript).length !== 3 || !TRANSCRIPT_OUTCOMES.has(stream.transcript.outcome)
      || typeof stream.transcript.language !== 'string' || typeof stream.transcript.errorCode !== 'string') throw new Error('invalid transcript outcome');
    if (streamRoles.has(stream.role) || (!availableRoles.has(stream.role) && !missingRoles.has(stream.role))) throw new Error('invalid stream role coverage');
    const availableOutcome = ['provided', 'transcribed', 'empty'].includes(stream.transcript.outcome);
    if (availableRoles.has(stream.role) !== availableOutcome
      || stream.transcript.outcome === 'empty' && stream.dialogue !== ''
      || stream.transcript.outcome !== 'empty' && availableOutcome && stream.dialogue === ''
      || missingRoles.has(stream.role) && stream.dialogue !== '') throw new Error('transcript outcome does not match stream coverage');
    streamRoles.add(stream.role);
    const { beginTime, endTime } = stream.streamContext;
    if (availableRoles.has(stream.role) && (!Number.isFinite(beginTime) || !Number.isFinite(endTime) || beginTime > endTime)) throw new Error('invalid resolved stream time window');
  });
  if (streamRoles.size !== availableRoles.size + missingRoles.size
    || input.coverageStatus === 'complete' && missingRoles.size !== 0
    || input.coverageStatus === 'partial' && missingRoles.size === 0) throw new Error('coverage status does not match stream roles');
  return input;
}
function hasCheckpoint(row) { return CHECKPOINTS.some((key) => text(row[key])); }
function reconcile(rows, input) {
  const own = rows.filter((row) => row.requestKey === input.requestKey);
  if (own.some((row) => !systemRowID(row.id))) throw new Error('invalid request system row id');
  const canonical = own.filter((row) => row.reconciliationStatus === 'canonical' && row.canonicalRowID === String(row.id));
  if (canonical.length !== 1) {
    if (canonical.length > 1 && own.some(hasCheckpoint)) return { action: 'freeze', rows: canonical };
    if (canonical.length > 1) {
      const winner = [...canonical].sort((a, b) => String(a.createdAtIso).localeCompare(String(b.createdAtIso)))[0];
      return { action: 'reconcile', winner, rows: canonical, mutations: canonical.filter((candidate) => candidate.id !== winner.id).map((candidate) => ({ id: candidate.id, desiredReconciliationStatus: 'duplicate', desiredCanonicalRowID: String(winner.id) })) };
    }
    throw new Error('exactly one canonical self-link is required');
  }
  const row = canonical[0];
  if (row.status !== 'summary_dispatching' || !text(row.leaseOwner) || !text(row.leaseUntilIso) || Date.parse(row.leaseUntilIso) <= Date.now()) throw new Error('owner lease gate failed');
  if (row.channel !== input.channel || row.threadTS !== input.threadTS || row.coverageStatus !== input.coverageStatus) throw new Error('immutable routing mismatch');
  exactArray(json(row.availableRolesJson, 'availableRolesJson'), input.availableRoles, 'availableRoles');
  exactArray(json(row.missingRolesJson, 'missingRolesJson'), input.missingRoles, 'missingRoles');
  exactArray(json(row.failedLogicalJobKeysJson, 'failedLogicalJobKeysJson'), input.failedLogicalJobKeys, 'failedLogicalJobKeys');
  return { action: 'owner', row };
}
function ownerConditions(row) {
  return { id: row.id, requestKey: row.requestKey, status: 'summary_dispatching', reconciliationStatus: 'canonical', canonicalRowID: String(row.id), leaseOwner: row.leaseOwner, leaseUntilIso: row.leaseUntilIso };
}
function stagePlan(row, stage, payload = {}) {
  const fields = stage === 'inference' ? ['inferenceResultJson', 'summaryMarkdown'] : stage === 'upload' ? ['summaryUploadID'] : ['summaryMessageTS'];
  if (fields.every((field) => text(row[field]))) return { action: 'skip', stage, row };
  return { action: 'side_effect', stage, row, conditions: ownerConditions(row), ...payload };
}
function checkpointPlan(row, stage, values) {
  const required = stage === 'inference' ? ['inferenceResultJson', 'summaryMarkdown'] : stage === 'upload' ? ['summaryUploadID'] : ['summaryMessageTS'];
  if (required.some((key) => !text(values[key]))) throw new Error(`missing ${stage} checkpoint`);
  return { action: 'checkpoint', stage, conditions: ownerConditions(row), values };
}
function failurePlan(row, stage, errorCode, now = new Date()) {
  const attempt = Number(row.summaryAttempt || 0);
  const next = attempt + 1;
  const status = next >= 3 ? 'failed' : 'summary_retry_pending';
  const delay = next === 1 ? 60000 : 300000;
  const rawCode = text(errorCode);
  const safeCode = /^[A-Za-z0-9_.-]{1,96}$/.test(rawCode) ? rawCode : 'summary_stage_failed';
  return { action: 'failure', stage, conditions: ownerConditions(row), values: { summaryAttempt: next, status, nextRetryAtIso: status === 'failed' ? '' : new Date(now.getTime() + delay).toISOString(), leaseOwner: '', leaseUntilIso: '', errorCode: safeCode } };
}
function completePlan(row) {
  if (!CHECKPOINTS.every((key) => text(row[key]))) throw new Error('all checkpoints are required before completion');
  return { action: 'complete', conditions: ownerConditions(row), values: { status: 'completed', nextRetryAtIso: '', errorCode: '', leaseOwner: '', leaseUntilIso: '' } };
}
function verify(row, plan) {
  if (!row || row.id !== plan.conditions.id) throw new Error('write verifier did not read canonical row');
  for (const [key, value] of Object.entries(plan.values || {})) if (row[key] !== value) throw new Error(`write verifier mismatch: ${key}`);
  return row;
}
function result(row) { return { requestKey: row.requestKey, status: row.status, coverageStatus: row.coverageStatus, summaryMessageTS: row.summaryMessageTS, summaryUploadID: row.summaryUploadID }; }

if (typeof module !== 'undefined') module.exports = { ALLOWED_CHANNELS, CHANNEL, validateInput, reconcile, ownerConditions, stagePlan, checkpointPlan, failurePlan, completePlan, systemRowID, verify, result };
if (typeof $input !== 'undefined') return $input.all().map(({ json: input }) => ({ json: validateInput(input) }));
