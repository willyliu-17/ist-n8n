const CHANNEL = 'C0A4JJJKJMD';
const MODES = Object.freeze({ first: 'fromStart', last: 'fromEnd', fromStart: 'fromStart', fromEnd: 'fromEnd' });
const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d{6}$/;
const DECIMAL_ID_PATTERN = /^\d+$/;

function requiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${fieldName} must be a non-empty string`);
  return value.trim();
}

function finiteNumber(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${fieldName} must be a finite number`);
  return value;
}

function canonicalContext(context, liveStreamID, index) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error(`orderedStreams[${index}].streamContext must be an object`);
  if (context.liveStreamID !== liveStreamID || context.eligible !== true
    || context.profile !== 'stt' || context.source !== 'livestream_v2') {
    throw new Error(`orderedStreams[${index}].streamContext is not resolver-owned eligible STT context`);
  }
  for (const field of ['userID', 'openID', 'region']) requiredString(context[field], `streamContext.${field}`);
  const beginTime = finiteNumber(context.beginTime, 'streamContext.beginTime');
  const endTime = finiteNumber(context.endTime, 'streamContext.endTime');
  const duration = finiteNumber(context.duration, 'streamContext.duration');
  const vliverModel = finiteNumber(context.vliverModel, 'streamContext.vliverModel');
  if (beginTime <= 0 || endTime <= beginTime || duration < 0 || vliverModel < 0) {
    throw new Error(`orderedStreams[${index}].streamContext has invalid numeric ranges`);
  }
  return { ...context };
}

function existingDialogueFor(existingDialogues, role, logicalJobKey) {
  const roleValue = existingDialogues[role];
  const keyValue = existingDialogues[logicalJobKey];
  if (roleValue !== undefined && keyValue !== undefined) throw new Error(`existingDialogues has ambiguous identity for role ${role}`);
  const value = roleValue ?? keyValue;
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`existingDialogues.${role} is invalid`);
  if (value.role !== undefined && value.role !== role) throw new Error(`existingDialogues.${role} role mismatch`);
  if (value.logicalJobKey !== undefined && value.logicalJobKey !== logicalJobKey) throw new Error(`existingDialogues.${role} logical identity mismatch`);
  return requiredString(value.dialogue, `existingDialogues.${role}.dialogue`);
}

function normalizeRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be an object');
  for (const field of ['candidateRows', 'candidates', 'suspectCandidates']) {
    if (Object.hasOwn(input, field)) throw new Error(`${field} is not owned by the Summary request boundary`);
  }
  const requestKey = requiredString(input.requestKey, 'requestKey');
  const requestType = requiredString(input.requestType, 'requestType');
  const channel = requiredString(input.channel, 'channel');
  const threadTS = requiredString(input.threadTS, 'threadTS');
  if (channel !== CHANNEL) throw new Error('channel must be the C0 test channel');
  if (!SLACK_TIMESTAMP_PATTERN.test(threadTS)) throw new Error('threadTS must be a strict Slack timestamp');
  if (!Array.isArray(input.orderedStreams) || input.orderedStreams.length === 0) throw new Error('orderedStreams must be a non-empty array');
  if (!input.existingDialogues || typeof input.existingDialogues !== 'object' || Array.isArray(input.existingDialogues)) {
    throw new Error('existingDialogues must be an object');
  }
  const roles = new Set();
  const orderedStreams = input.orderedStreams.map((stream, index) => {
    if (!stream || typeof stream !== 'object' || Array.isArray(stream)) throw new Error(`orderedStreams[${index}] must be an object`);
    const role = requiredString(stream.role, `orderedStreams[${index}].role`);
    if (roles.has(role)) throw new Error(`orderedStreams role must be unique: ${role}`);
    roles.add(role);
    const liveStreamID = requiredString(stream.liveStreamID, `orderedStreams[${index}].liveStreamID`);
    if (!DECIMAL_ID_PATTERN.test(liveStreamID)) throw new Error(`orderedStreams[${index}].liveStreamID must be a numeric string`);
    const mode = MODES[stream.mode];
    if (!mode) throw new Error(`orderedStreams[${index}].mode is invalid`);
    const durationMinutes = finiteNumber(stream.durationMinutes, `orderedStreams[${index}].durationMinutes`);
    if (durationMinutes <= 0) throw new Error(`orderedStreams[${index}].durationMinutes must be positive`);
    const logicalJobKey = `${requestKey}:${role}:${liveStreamID}:${mode}`;
    const dialogue = existingDialogueFor(input.existingDialogues, role, logicalJobKey);
    let processingMessageTS = '';
    if (dialogue === '') {
      processingMessageTS = requiredString(stream.processingMessageTS, `orderedStreams[${index}].processingMessageTS`);
      if (!SLACK_TIMESTAMP_PATTERN.test(processingMessageTS)) {
        throw new Error(`orderedStreams[${index}].processingMessageTS must be a persisted Slack timestamp`);
      }
    }
    return {
      role,
      liveStreamID,
      mode,
      durationMinutes,
      streamContext: canonicalContext(stream.streamContext, liveStreamID, index),
      ...(processingMessageTS ? { processingMessageTS } : {}),
    };
  });
  const knownKeys = new Set([...roles]);
  for (const stream of orderedStreams) knownKeys.add(`${requestKey}:${stream.role}:${stream.liveStreamID}:${stream.mode}`);
  for (const key of Object.keys(input.existingDialogues)) {
    if (!knownKeys.has(key)) throw new Error(`existingDialogues contains unknown identity: ${key}`);
  }
  const existingDialogues = {};
  const expectedLogicalJobKeys = [];
  for (const stream of orderedStreams) {
    const logicalJobKey = `${requestKey}:${stream.role}:${stream.liveStreamID}:${stream.mode}`;
    const dialogue = existingDialogueFor(input.existingDialogues, stream.role, logicalJobKey);
    if (dialogue) existingDialogues[stream.role] = { logicalJobKey, dialogue };
    else expectedLogicalJobKeys.push(logicalJobKey);
  }
  return {
    requestKey,
    requestType,
    orderedStreams,
    existingDialogues,
    channel,
    threadTS,
    orderedStreamsJson: JSON.stringify(orderedStreams),
    existingDialoguesJson: JSON.stringify(existingDialogues),
    expectedLogicalJobKeysJson: JSON.stringify(expectedLogicalJobKeys),
    expectedLogicalJobKeys,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CHANNEL, MODES, SLACK_TIMESTAMP_PATTERN, normalizeRequest };
}

if (typeof $input !== 'undefined') {
  return [{ json: normalizeRequest($input.first().json) }];
}
