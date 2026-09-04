const MAX_TEXT_LENGTH = 512;
const MAX_FIELD_LENGTH = 128;
const SCHEMA_KEYS = Object.freeze([
  'errorKey', 'component', 'reconciliationStatus', 'canonicalRowID', 'requestKey',
  'logicalJobKey', 'attemptKey', 'executionID', 'workflowName', 'nodeName',
  'errorCode', 'messageMasked', 'retryable', 'createdAtIso',
]);

function normalizeText(value, limit = MAX_FIELD_LENGTH) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function maskText(value, limit = MAX_TEXT_LENGTH) {
  return normalizeText(value, limit)
    .replace(/\b(https?:\/\/[^\s'"<>]+)(?=[\s'"<>]|$)/gi, (url) => {
      const boundary = url.search(/[?#]/);
      return boundary === -1 ? url : `${url.slice(0, boundary)}[redacted]`;
    })
    .replace(/\bauthorization\b\s*[:=]\s*(?:bearer|basic)\s+[^,;\s]+/gi, 'authorization=[redacted]')
    .replace(/\b(authorization|bearer|basic|api[-_ ]?key|token|password|secret|cookie)\b\s*[:=]\s*([^,;\s]+)/gi, '$1=[redacted]')
    .replace(/(["']?(?:callbackToken|accessToken|refreshToken|credential(?:Value)?|api[-_]?key|password|secret)["']?\s*:\s*)["']?[^,}\s"']+["']?/gi, '$1[redacted]')
    .slice(0, limit);
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function directPrimitive(sources, names, limit = MAX_FIELD_LENGTH) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const name of names) {
      if (typeof source[name] === 'string' || typeof source[name] === 'number') {
        return normalizeText(source[name], limit);
      }
    }
  }
  return '';
}

function retryableFrom(error) {
  const status = Number(error?.httpCode ?? error?.statusCode ?? error?.status ?? 0);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return new Set(['TimeoutError', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED']).has(normalizeText(error?.name, 64));
}

function maskErrorEnvelope(envelope, now = new Date().toISOString()) {
  const execution = envelope?.execution && typeof envelope.execution === 'object' ? envelope.execution : {};
  const workflow = envelope?.workflow && typeof envelope.workflow === 'object' ? envelope.workflow : {};
  const error = execution?.error && typeof execution.error === 'object'
    ? execution.error
    : (envelope?.error && typeof envelope.error === 'object' ? envelope.error : {});
  const sources = [envelope, execution, workflow, error];
  const workflowName = directPrimitive([workflow, envelope], ['name', 'workflowName']);
  const nodeName = directPrimitive([execution, envelope], ['lastNodeExecuted', 'nodeName']);
  const executionID = directPrimitive([execution, envelope], ['id', 'executionID']);
  const component = normalizeText(workflowName || 'n8n_error_workflow', MAX_FIELD_LENGTH).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'n8n_error_workflow';
  const requestKey = directPrimitive(sources, ['requestKey']);
  const logicalJobKey = directPrimitive(sources, ['logicalJobKey']);
  const attemptKey = directPrimitive(sources, ['attemptKey']);
  const errorCode = normalizeText(error.name || error.code || 'workflow_error', 96).replace(/[^A-Za-z0-9_.-]/g, '_') || 'workflow_error';
  const messageMasked = maskText(error.message || error.description || errorCode);
  const errorKey = `err:v1:${fnv1a([component, requestKey, logicalJobKey, attemptKey, executionID || 'no-execution', workflowName, nodeName, errorCode].join('|'))}`;

  return {
    errorKey,
    component,
    reconciliationStatus: 'pending',
    canonicalRowID: '',
    requestKey,
    logicalJobKey,
    attemptKey,
    executionID,
    workflowName,
    nodeName,
    errorCode,
    messageMasked,
    retryable: retryableFrom(error),
    createdAtIso: normalizeText(now, 40),
  };
}

if (typeof module !== 'undefined') module.exports = { SCHEMA_KEYS, maskErrorEnvelope, maskText, normalizeText, retryableFrom };

if (typeof $input !== 'undefined') {
  return $input.all().map(({ json }) => ({ json: maskErrorEnvelope(json) }));
}
