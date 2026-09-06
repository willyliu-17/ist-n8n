const PROFILE_FIELDS = {
  core: ['liveStreamID', 'userID', 'openID', 'beginTime', 'endTime', 'duration', 'closeBy', 'streamMode', 'vliverModel', 'isOBS'],
  stt: ['liveStreamID', 'userID', 'beginTime', 'endTime', 'duration', 'caption', 'region', 'vliverModel', 'appVersion', 'deviceType', 'isOBS', 'closeBy', 'streamMode', 'deviceModel', 'osVersion', 'publicIP', 'ipRegion', 'openID'],
  vds: ['liveStreamID', 'userID', 'beginTime', 'endTime', 'publishSec', 'region', 'ipRegion'],
};

const REQUIRED_FIELDS = {
  core: ['liveStreamID', 'userID', 'beginTime', 'endTime'],
  stt: ['liveStreamID', 'userID', 'beginTime', 'endTime', 'openID', 'duration', 'region', 'vliverModel'],
  vds: ['liveStreamID', 'userID', 'beginTime', 'endTime', 'publishSec'],
};

const NUMERIC_FIELDS = new Set(['beginTime', 'endTime', 'duration', 'publishSec', 'vliverModel']);
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const OUTPUT_FIELDS = [
  'liveStreamID', 'userID', 'openID', 'beginTime', 'endTime', 'duration', 'region',
  'appVersion', 'deviceType', 'publishSec', 'vliverModel', 'closeBy', 'streamMode',
  'isOBS', 'caption', 'deviceModel', 'osVersion', 'publicIP', 'ipRegion',
];

function parseNonNegativeDecimal(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeField(field, value) {
  if (field === 'isOBS') {
    if (typeof value === 'boolean') return { missing: false, value };
    if (value === 'true' || value === 'false') return { missing: false, value: value === 'true' };
    return { missing: true, value: null };
  }
  if (NUMERIC_FIELDS.has(field)) {
    const parsed = parseNonNegativeDecimal(value);
    return { missing: parsed === null, value: parsed };
  }
  const missing = value === null || value === undefined
    || (typeof value === 'string' && value.trim() === '');
  return { missing, value: missing ? null : value };
}

function isMissing(field, value) {
  return normalizeField(field, value).missing;
}

function finalize(normalized, rows) {
  if (!normalized || !PROFILE_FIELDS[normalized.profile] || !Array.isArray(normalized.inputStreams)) {
    throw new Error('Invalid normalized resolver context');
  }

  const source = normalized.profile === 'core' ? 'datamart' : 'livestream_v2';
  const rowsByID = new Map();
  for (const row of rows || []) {
    if (!row || isMissing('liveStreamID', row.liveStreamID)) continue;
    const liveStreamID = String(row.liveStreamID).trim();
    if (!rowsByID.has(liveStreamID)) rowsByID.set(liveStreamID, row);
  }

  return normalized.inputStreams.map(({ inputIndex, liveStreamID }) => {
    const row = rowsByID.get(liveStreamID);
    const output = {
      inputIndex,
      status: 'not_found',
      source,
      profile: normalized.profile,
    };
    for (const field of OUTPUT_FIELDS) output[field] = null;
    output.liveStreamID = liveStreamID;

    if (!row) {
      output.missingFields = [...PROFILE_FIELDS[normalized.profile]];
      output.eligible = false;
      return output;
    }

    const normalizedFields = new Map(OUTPUT_FIELDS.map((field) => {
      const rawValue = field === 'vliverModel' && normalized.profile === 'stt'
        && (row[field] === null || row[field] === undefined || (typeof row[field] === 'string' && row[field].trim() === ''))
        ? 0
        : row[field];
      return [field, normalizeField(field, rawValue)];
    }));
    for (const field of OUTPUT_FIELDS) {
      if (field !== 'liveStreamID') output[field] = normalizedFields.get(field).value;
    }

    const missingFields = PROFILE_FIELDS[normalized.profile]
      .filter((field) => normalizedFields.get(field).missing);
    const beginTime = normalizedFields.get('beginTime').value;
    const endTime = normalizedFields.get('endTime').value;
    if (beginTime !== null && endTime !== null && endTime <= beginTime && !missingFields.includes('endTime')) {
      missingFields.push('endTime');
    }

    output.missingFields = missingFields;
    output.status = missingFields.length === 0 ? 'found' : 'partial';
    output.eligible = REQUIRED_FIELDS[normalized.profile].every((field) => !missingFields.includes(field));
    return output;
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { finalize, isMissing, parseNonNegativeDecimal, PROFILE_FIELDS, REQUIRED_FIELDS };
}

if (typeof $input !== 'undefined') {
  const normalized = $('Validate and Normalize').first().json;
  const rows = $input.all().map((item) => item.json);
  return finalize(normalized, rows).map((json) => ({ json }));
}
