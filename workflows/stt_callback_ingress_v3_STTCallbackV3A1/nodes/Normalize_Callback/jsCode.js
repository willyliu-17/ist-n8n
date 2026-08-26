const CONTEXT_KEYS = Object.freeze([
  'attemptKey',
  'logicalJobKey',
  'requestKey',
  'requestType',
  'streamID',
  'mode',
  'channel',
  'threadTS',
  'processingMessageTS',
  'callbackToken',
]);
const CONTEXT_KEY_SET = new Set(CONTEXT_KEYS);
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function malformed() {
  return {
    valid: false,
    action: 'reject',
    responseClass: 'malformed',
    httpStatus: 400,
    errorCode: 'malformed_callback',
    messageMasked: 'Malformed callback request',
  };
}

function contextObject(value) {
  if (Array.isArray(value)) {
    const result = {};
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 2) {
        throw new Error('Invalid callback context entries');
      }
      const lowerCasePair = Object.hasOwn(entry, 'key') && Object.hasOwn(entry, 'value');
      const upperCasePair = Object.hasOwn(entry, 'Key') && Object.hasOwn(entry, 'Value');
      if (lowerCasePair === upperCasePair) throw new Error('Invalid callback context entries');
      const key = lowerCasePair ? entry.key : entry.Key;
      const entryValue = lowerCasePair ? entry.value : entry.Value;
      if (typeof key !== 'string' || !CONTEXT_KEY_SET.has(key) || Object.hasOwn(result, key)) {
        throw new Error('Invalid callback context entries');
      }
      result[key] = entryValue;
    }
    return result;
  }
  if (!value || typeof value !== 'object') throw new Error('Invalid callback context');
  return { ...value };
}

function parseStatusCode(value) {
  const statusCode = typeof value === 'string' && /^\d{3}$/.test(value)
    ? Number(value)
    : value;
  if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) {
    return statusCode;
  }
  throw new Error('Invalid callback status code');
}

function normalizeCallback(item) {
  try {
    const body = item?.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid callback body');
    const context = contextObject(body.webhook?.context);
    if (
      Object.keys(context).length !== CONTEXT_KEYS.length ||
      CONTEXT_KEYS.some((key) => !Object.hasOwn(context, key))
    ) {
      throw new Error('Invalid canonical callback context');
    }
    for (const key of CONTEXT_KEYS.filter((key) => key !== 'callbackToken')) {
      if (typeof context[key] !== 'string' || !context[key]) throw new Error(`Invalid callback context ${key}`);
    }
    if (!['fromStart', 'fromEnd'].includes(context.mode)) throw new Error('Invalid canonical callback mode');
    if (context.channel !== 'C0A4JJJKJMD') throw new Error('Invalid callback channel');
    if (!/^[0-9a-f]{64}$/.test(context.callbackToken)) throw new Error('Invalid callback token format');
    if (body.transcription !== undefined && typeof body.transcription !== 'string') {
      throw new Error('Invalid callback transcription');
    }
    if (body.languages !== undefined && !Array.isArray(body.languages)) {
      throw new Error('Invalid callback languages');
    }
    const languageValue = body.languages?.[0] ?? '';
    if (typeof languageValue !== 'string') throw new Error('Invalid callback language');
    const statusCode = parseStatusCode(body.statusCode);
    return {
      valid: true,
      action: 'continue',
      context,
      statusCode,
      transcription: (body.transcription || '').trim(),
      language: languageValue.trim(),
      retryableServiceError: body.retryable === true || RETRYABLE_STATUS_CODES.has(statusCode),
    };
  } catch {
    return malformed();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CONTEXT_KEYS, contextObject, normalizeCallback };
}

if (typeof $input !== 'undefined') {
  return [{ json: normalizeCallback($input.first().json) }];
}
