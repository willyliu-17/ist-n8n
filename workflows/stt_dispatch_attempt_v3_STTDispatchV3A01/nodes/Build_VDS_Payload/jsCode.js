const CALLBACK_PATH = '/webhook/stt-callback-v3';
const ALLOWED_MODES = new Set(['fromStart', 'fromEnd']);
const C0_CHANNEL = 'C0A4JJJKJMD';

function addMinutes(iso, minutes) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid ISO timestamp');
  return new Date(timestamp + minutes * 60_000).toISOString();
}

function tokenExpiry(nowIso) {
  return addMinutes(nowIso, 120);
}

function dispatchLeaseExpiry(nowIso) {
  return addMinutes(nowIso, 5);
}

function callbackDeadline(submittedAtIso) {
  return addMinutes(submittedAtIso, 30);
}

function validateCallbackUrl(callbackUrl) {
  if (typeof callbackUrl !== 'string' || !callbackUrl.startsWith('https://')) {
    throw new Error('Callback URL must use HTTPS');
  }
  const match = /^https:\/\/([^/?#@]+)(\/[^?#]*)$/.exec(callbackUrl);
  if (!match) throw new Error('Invalid fixed callback path');
  const [, authority, pathname] = match;
  const authorityMatch = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::([1-9]\d{0,4}))?$/.exec(authority);
  if (!authorityMatch || (authorityMatch[1] && Number(authorityMatch[1]) > 65535)) {
    throw new Error('Invalid HTTPS callback URL');
  }
  if (pathname !== CALLBACK_PATH) throw new Error('Invalid fixed callback path');
  return callbackUrl;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid canonical ${field}`);
  return value;
}

function strictFiniteNumber(value, field) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid canonical ${field}`);
    return value;
  }
  if (typeof value !== 'string') throw new Error(`Invalid canonical ${field}`);
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    throw new Error(`Invalid canonical ${field}`);
  }
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw new Error(`Invalid canonical ${field}`);
  return number;
}

function buildVdsPayload(attempt, rawToken, callbackUrl, scheduledAt = Date.now()) {
  if (!attempt || typeof attempt !== 'object') throw new Error('Missing canonical attempt');
  if (!ALLOWED_MODES.has(attempt.mode)) throw new Error('Invalid canonical mode');
  if (attempt.channel !== C0_CHANNEL) throw new Error('Invalid channel');
  if (typeof rawToken !== 'string' || !/^[0-9a-f]{64}$/i.test(rawToken)) {
    throw new Error('Invalid 32-byte callback token');
  }
  if (!Number.isFinite(scheduledAt)) throw new Error('Invalid scheduled time');

  let streamContext;
  try {
    streamContext = JSON.parse(attempt.streamContextJson);
  } catch {
    throw new Error('Invalid canonical stream context');
  }

  const createdTime = strictFiniteNumber(streamContext.beginTime, 'createdTime');
  const endTime = strictFiniteNumber(streamContext.endTime, 'endTime');
  const duration = strictFiniteNumber(streamContext.duration, 'duration');
  const vliverModel = strictFiniteNumber(streamContext.vliverModel, 'vliverModel');
  const durationMinutes = strictFiniteNumber(attempt.durationMinutes, 'durationMinutes');
  if (createdTime <= 0) throw new Error('Invalid canonical createdTime');
  if (endTime <= 0) throw new Error('Invalid canonical endTime');
  if (endTime <= createdTime) throw new Error('Canonical endTime must be greater than createdTime');
  if (duration < 0) throw new Error('Invalid canonical duration');
  if (vliverModel < 0) throw new Error('Invalid canonical vliverModel');
  if (durationMinutes <= 0) throw new Error('Invalid canonical durationMinutes');

  return {
    userID: requiredString(streamContext.userID, 'userID'),
    openID: requiredString(streamContext.openID, 'openID'),
    streamID: requiredString(attempt.streamID, 'streamID'),
    region: requiredString(streamContext.region, 'region'),
    sttModel: 'whisper-large-v3',
    language: '',
    createdTime,
    endTime,
    duration,
    scheduledAt,
    contractType: 1,
    vliverModel,
    appVersion: typeof streamContext.appVersion === 'string' ? streamContext.appVersion : '',
    deviceType: typeof streamContext.deviceType === 'string' ? streamContext.deviceType : '',
    streamSegment: {
      mode: attempt.mode,
      durationMinutes,
    },
    webhookConfiguration: {
      url: validateCallbackUrl(callbackUrl),
      context: {
        attemptKey: requiredString(attempt.attemptKey, 'attemptKey'),
        logicalJobKey: requiredString(attempt.logicalJobKey, 'logicalJobKey'),
        requestKey: requiredString(attempt.requestKey, 'requestKey'),
        requestType: requiredString(attempt.requestType, 'requestType'),
        streamID: attempt.streamID,
        mode: attempt.mode,
        channel: attempt.channel,
        threadTS: requiredString(attempt.threadTS, 'threadTS'),
        processingMessageTS: requiredString(attempt.processingMessageTS, 'processingMessageTS'),
        callbackToken: rawToken,
      },
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildVdsPayload,
    callbackDeadline,
    dispatchLeaseExpiry,
    strictFiniteNumber,
    tokenExpiry,
  };
}

if (typeof $input !== 'undefined') {
  const input = $input.first().json;
  return [{ json: buildVdsPayload(input, input.callbackToken, input.callbackUrl) }];
}
