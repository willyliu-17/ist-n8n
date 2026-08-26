const CHANNEL = 'C0A4JJJKJMD';
const STREAM_ID_PATTERN = /^[0-9]{1,20}$/;
const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d{6}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MODE_ALIASES = Object.freeze({
  first: 'fromStart',
  last: 'fromEnd',
  fromStart: 'fromStart',
  fromEnd: 'fromEnd',
});
const RESOLVER_CONTEXT_FIELDS = Object.freeze([
  'inputIndex', 'status', 'source', 'profile', 'liveStreamID', 'userID', 'openID',
  'beginTime', 'endTime', 'duration', 'region', 'appVersion', 'deviceType',
  'publishSec', 'vliverModel', 'closeBy', 'streamMode', 'isOBS', 'caption',
  'deviceModel', 'osVersion', 'publicIP', 'ipRegion', 'missingFields', 'eligible',
]);
const REQUIRED_STT_FIELDS = Object.freeze([
  'liveStreamID', 'userID', 'beginTime', 'endTime', 'openID', 'duration', 'vliverModel', 'region',
]);
const REQUIRED_STT_STRING_FIELDS = Object.freeze(['userID', 'openID', 'region']);
const REQUIRED_STT_NUMBER_FIELDS = Object.freeze(['beginTime', 'endTime', 'duration', 'vliverModel']);

function pad(value) {
  return String(value).padStart(2, '0');
}

function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function parseRfc3339(value, fieldName) {
  if (typeof value !== 'string') throw new Error(`${fieldName} must be an RFC3339 timestamp`);
  const match = RFC3339_PATTERN.exec(value);
  if (!match) throw new Error(`${fieldName} must be an RFC3339 timestamp with an offset`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset, sign, offsetHourText, offsetMinuteText] = match;
  const values = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = values;
  const offsetHour = offset === 'Z' ? 0 : Number(offsetHourText);
  const offsetMinute = offset === 'Z' ? 0 : Number(offsetMinuteText);
  if (!validCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(`${fieldName} must be a valid RFC3339 timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${fieldName} must be a valid RFC3339 timestamp`);
  const offsetMinutes = offset === 'Z' ? 0 : (sign === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  return { timestamp, offsetMinutes, offset: offset === 'Z' ? 'Z' : `${sign}${pad(offsetHour)}:${pad(offsetMinute)}` };
}

function formatAtOffset(timestamp, offsetMinutes, offset) {
  const local = new Date(timestamp + offsetMinutes * 60 * 1000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
    + `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offset}`;
}

function parseDate(value) {
  if (typeof value !== 'string') throw new Error('date must be a YYYY-MM-DD string');
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new Error('date must match YYYY-MM-DD');
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!validCalendarDate(year, month, day)) throw new Error('date must be a valid calendar date');
  return { year, month, day };
}

function buildLookupWindow({ date, nowIso } = {}) {
  if (date !== undefined && date !== '') {
    const { year, month, day } = parseDate(date);
    const nextLocal = new Date(Date.UTC(year, month - 1, day + 1, 4, 0, 0));
    return {
      start: `${year}-${pad(month)}-${pad(day)}T04:00:00+08:00`,
      end: `${nextLocal.getUTCFullYear()}-${pad(nextLocal.getUTCMonth() + 1)}-${pad(nextLocal.getUTCDate())}T04:00:00+08:00`,
    };
  }
  const current = parseRfc3339(nowIso || formatAtOffset(Date.now(), 8 * 60, '+08:00'), 'nowIso');
  return {
    start: formatAtOffset(current.timestamp - 30 * DAY_MS, current.offsetMinutes, current.offset),
    end: formatAtOffset(current.timestamp, current.offsetMinutes, current.offset),
  };
}

function extendPairingWindow(baseWindow, pairing = {}) {
  const start = parseRfc3339(baseWindow?.start, 'baseWindow.start');
  const end = parseRfc3339(baseWindow?.end, 'baseWindow.end');
  if (start.timestamp >= end.timestamp || end.timestamp - start.timestamp > 24 * HOUR_MS) {
    throw new Error('baseWindow must be an ordered window of at most 24 hours');
  }
  let startValue = baseWindow.start;
  let endValue = baseWindow.end;
  if (pairing.previousBegin !== undefined && pairing.previousBegin !== '') {
    const previous = parseRfc3339(pairing.previousBegin, 'pairing.previousBegin');
    if (previous.timestamp < start.timestamp) {
      const bounded = Math.max(previous.timestamp, start.timestamp - 6 * HOUR_MS);
      startValue = bounded === previous.timestamp
        ? pairing.previousBegin
        : formatAtOffset(bounded, start.offsetMinutes, start.offset);
    }
  }
  if (pairing.currentEnd !== undefined && pairing.currentEnd !== '') {
    const current = parseRfc3339(pairing.currentEnd, 'pairing.currentEnd');
    if (current.timestamp > end.timestamp) {
      const bounded = Math.min(current.timestamp, end.timestamp + 6 * HOUR_MS);
      endValue = bounded === current.timestamp
        ? pairing.currentEnd
        : formatAtOffset(bounded, end.offsetMinutes, end.offset);
    }
  }
  if (parseRfc3339(endValue, 'result.end').timestamp - parseRfc3339(startValue, 'result.start').timestamp > 36 * HOUR_MS) {
    throw new Error('Pairing window exceeds 36 hours');
  }
  return { start: startValue, end: endValue };
}

function buildPreviousFallbackWindow(baseWindow, days = 30) {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('previous fallback days must be 1..30');
  const start = parseRfc3339(baseWindow?.start, 'baseWindow.start');
  return {
    start: formatAtOffset(start.timestamp - days * DAY_MS, start.offsetMinutes, start.offset),
    end: baseWindow.start,
  };
}

function epochSecondsToTaipeiRfc3339(value, fieldName) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive safe epoch-second integer`);
  }
  return formatAtOffset(value * 1000, 8 * 60, '+08:00');
}

function validateDiscoveryRow(rows, expectedStreamID) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Discovery resolver must return exactly one stream context');
  const row = rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid discovery resolver context');
  for (const field of RESOLVER_CONTEXT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) throw new Error(`Discovery resolver context is missing ${field}`);
  }
  if (row.profile !== 'stt' || row.source !== 'livestream_v2' || row.inputIndex !== 0 || row.liveStreamID !== expectedStreamID) {
    throw new Error('Discovery resolver ownership metadata is invalid');
  }
  if (!['found', 'partial', 'not_found'].includes(row.status)) throw new Error('Discovery resolver status is invalid');
  if (row.status === 'not_found' && (row.eligible !== false || row.beginTime !== null || row.endTime !== null)) {
    throw new Error('Discovery not_found context is malformed');
  }
  return row;
}

function planDiscoveryWindow(rows, normalizedInput, discoveryPhase) {
  if (!['base', 'fallback'].includes(discoveryPhase)) throw new Error('Discovery phase is invalid');
  const row = validateDiscoveryRow(rows, normalizedInput?.streamID);
  const hasUsableBoundaries = ['found', 'partial'].includes(row.status)
    && typeof row.beginTime === 'number' && Number.isSafeInteger(row.beginTime) && row.beginTime > 0
    && typeof row.endTime === 'number' && Number.isSafeInteger(row.endTime) && row.endTime > row.beginTime;

  if (!hasUsableBoundaries) {
    if (row.status === 'found') throw new Error('Discovery found context has invalid beginTime or endTime');
    if (discoveryPhase === 'base' && (row.status === 'not_found' || row.status === 'partial')) {
      return {
        streamID: normalizedInput.streamID,
        baseLookupWindow: normalizedInput.lookupWindow,
        previousFallbackWindow: normalizedInput.previousFallbackWindow,
        finalLookupWindow: null,
        discoverySource: 'base',
        needsFallback: true,
      };
    }
    throw new Error('Discovery resolver did not provide usable beginTime and endTime');
  }

  const pairing = {
    previousBegin: epochSecondsToTaipeiRfc3339(row.beginTime, 'discovery.beginTime'),
    currentEnd: epochSecondsToTaipeiRfc3339(row.endTime, 'discovery.endTime'),
  };
  const finalLookupWindow = normalizedInput.date === ''
    ? { ...normalizedInput.lookupWindow }
    : extendPairingWindow(normalizedInput.lookupWindow, pairing);
  return {
    streamID: normalizedInput.streamID,
    baseLookupWindow: normalizedInput.lookupWindow,
    previousFallbackWindow: normalizedInput.previousFallbackWindow,
    finalLookupWindow,
    discoverySource: discoveryPhase,
    needsFallback: false,
  };
}

function normalizeStandaloneInput(input, nowIso) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be an object');
  if (typeof input.streamID !== 'string' || !STREAM_ID_PATTERN.test(input.streamID)) {
    throw new Error('streamID must match ^[0-9]{1,20}$');
  }
  if (input.channel !== CHANNEL) throw new Error('Slack channel is not allowed');
  if (typeof input.command_ts !== 'string' || !SLACK_TIMESTAMP_PATTERN.test(input.command_ts)) {
    throw new Error('command_ts must be a Slack timestamp');
  }
  if (typeof input.target_thread_ts !== 'string' || !SLACK_TIMESTAMP_PATTERN.test(input.target_thread_ts)) {
    throw new Error('target_thread_ts must be a Slack timestamp');
  }
  if (typeof input.mins !== 'number' || !Number.isFinite(input.mins) || input.mins <= 0) {
    throw new Error('mins must be a positive finite number');
  }
  const mode = MODE_ALIASES[input.mode];
  if (!mode) throw new Error('mode must be first, last, fromStart, or fromEnd');
  const date = input.date === undefined ? '' : input.date;
  if (typeof date !== 'string') throw new Error('date must be a string');
  const lookupWindow = buildLookupWindow({ date, nowIso });
  return {
    streamID: input.streamID,
    mode,
    mins: input.mins,
    date,
    channel: CHANNEL,
    command_ts: input.command_ts,
    target_thread_ts: input.target_thread_ts,
    lookupWindow,
    previousFallbackWindow: buildPreviousFallbackWindow(lookupWindow),
  };
}

function requireEligibleResolverContext(rows, expectedStreamID) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Resolver must return exactly one stream context');
  const row = rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid resolver stream context');
  if (row.profile !== 'stt' || row.source !== 'livestream_v2' || row.inputIndex !== 0) {
    throw new Error('Resolver ownership metadata is invalid');
  }
  if (row.liveStreamID !== expectedStreamID || row.eligible !== true || !['found', 'partial'].includes(row.status)) {
    throw new Error('Stream is not eligible for STT');
  }
  for (const field of RESOLVER_CONTEXT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) throw new Error(`Resolver context is missing ${field}`);
  }
  for (const field of REQUIRED_STT_FIELDS) {
    if (row[field] === null || row[field] === undefined || row[field] === '') {
      throw new Error(`Eligible resolver context is missing ${field}`);
    }
  }
  for (const field of REQUIRED_STT_STRING_FIELDS) {
    if (typeof row[field] !== 'string' || row[field].length === 0) {
      throw new Error(`Eligible resolver context has invalid ${field}`);
    }
  }
  for (const field of REQUIRED_STT_NUMBER_FIELDS) {
    if (typeof row[field] !== 'number' || !Number.isFinite(row[field])) {
      throw new Error(`Eligible resolver context has invalid ${field}`);
    }
  }
  if (row.beginTime <= 0) throw new Error('Eligible resolver context has invalid beginTime');
  if (row.endTime <= row.beginTime) throw new Error('Eligible resolver context endTime must be greater than beginTime');
  if (row.duration < 0) throw new Error('Eligible resolver context has invalid duration');
  if (row.vliverModel < 0) throw new Error('Eligible resolver context has invalid vliverModel');
  const context = {};
  for (const field of RESOLVER_CONTEXT_FIELDS) context[field] = row[field];
  return context;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CHANNEL,
    MODE_ALIASES,
    RESOLVER_CONTEXT_FIELDS,
    buildLookupWindow,
    buildPreviousFallbackWindow,
    epochSecondsToTaipeiRfc3339,
    extendPairingWindow,
    normalizeStandaloneInput,
    parseRfc3339,
    planDiscoveryWindow,
    requireEligibleResolverContext,
  };
}

if (typeof $input !== 'undefined') {
  const first = $input.first().json;
  if (Object.prototype.hasOwnProperty.call(first, 'streamID') && Object.prototype.hasOwnProperty.call(first, 'target_thread_ts')) {
    return [{ json: normalizeStandaloneInput(first) }];
  }
  if (Object.prototype.hasOwnProperty.call(first, 'discoveryPhase')) {
    const normalized = $('Normalize Standalone Input').first().json;
    const rows = $input.all().map(({ json }) => {
      const { discoveryPhase, ...row } = json;
      return row;
    });
    return [{ json: planDiscoveryWindow(rows, normalized, first.discoveryPhase) }];
  }
  const expectedStreamID = $('Normalize Standalone Input').first().json.streamID;
  const context = requireEligibleResolverContext($input.all().map(({ json }) => json), expectedStreamID);
  return [{ json: context }];
}
