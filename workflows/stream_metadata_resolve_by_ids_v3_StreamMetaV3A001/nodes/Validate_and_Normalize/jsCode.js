const ID_PATTERN = /^[0-9]{1,20}$/;
const RFC3339_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_INT64 = BigInt('9223372036854775807');

function parseRfc3339WithOffset(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be an RFC3339 string with an offset`);
  }

  const match = RFC3339_WITH_OFFSET.exec(value);
  if (!match) {
    throw new Error(`${fieldName} must be an RFC3339 string with an offset`);
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  const validCalendarDate = calendarCheck.getUTCFullYear() === year
    && calendarCheck.getUTCMonth() === month - 1
    && calendarCheck.getUTCDate() === day;
  const validTime = hour <= 23 && minute <= 59 && second <= 59;
  const validOffset = offset === 'Z'
    || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59);
  const timestamp = Date.parse(value);

  if (!validCalendarDate || !validTime || !validOffset || !Number.isFinite(timestamp)) {
    throw new Error(`${fieldName} must be a valid RFC3339 timestamp with an offset`);
  }

  return timestamp;
}

function validateAndNormalize(input, nowMs = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Input must be an object');
  }
  if (!Array.isArray(input.streams) || input.streams.length < 1 || input.streams.length > 100) {
    throw new Error('streams must contain 1..100 items');
  }
  if (!['core', 'stt', 'vds'].includes(input.profile)) {
    throw new Error('profile must be core, stt, or vds');
  }

  const inputStreams = input.streams.map((stream, inputIndex) => {
    if (!stream || typeof stream !== 'object' || Array.isArray(stream)) {
      throw new Error(`streams[${inputIndex}] must be an object`);
    }
    if (typeof stream.liveStreamID !== 'string') {
      throw new Error(`streams[${inputIndex}].liveStreamID must be a string`);
    }
    const liveStreamID = stream.liveStreamID.trim();
    if (!ID_PATTERN.test(liveStreamID)) {
      throw new Error(`streams[${inputIndex}].liveStreamID must match ^[0-9]{1,20}$ after trimming`);
    }
    return { inputIndex, liveStreamID };
  });

  if (!Number.isFinite(nowMs)) {
    throw new Error('Current time must be finite');
  }

  let windowStart;
  let windowEnd;
  if (input.lookupWindow === undefined) {
    windowEnd = new Date(nowMs).toISOString();
    windowStart = new Date(nowMs - DEFAULT_WINDOW_MS).toISOString();
  } else {
    if (!input.lookupWindow || typeof input.lookupWindow !== 'object' || Array.isArray(input.lookupWindow)) {
      throw new Error('lookupWindow must be an object');
    }
    const startMs = parseRfc3339WithOffset(input.lookupWindow.start, 'lookupWindow.start');
    const endMs = parseRfc3339WithOffset(input.lookupWindow.end, 'lookupWindow.end');
    if (startMs >= endMs) {
      throw new Error('lookupWindow.start must be before lookupWindow.end');
    }
    if (endMs - startMs > MAX_WINDOW_MS) {
      throw new Error('lookupWindow must not exceed 31 days');
    }
    windowStart = input.lookupWindow.start;
    windowEnd = input.lookupWindow.end;
  }

  const uniqueIDs = [...new Set(inputStreams.map((stream) => stream.liveStreamID))];
  const stringIdsSqlLiteral = `[${uniqueIDs.map((id) => `'${id}'`).join(',')}]`;
  let int64IdsSqlLiteral = null;
  if (input.profile !== 'core') {
    const int64IDs = uniqueIDs.map((id) => {
      const value = BigInt(id);
      if (value > MAX_INT64) {
        throw new Error(`liveStreamID ${id} exceeds the BigQuery INT64 range`);
      }
      return value.toString();
    });
    int64IdsSqlLiteral = `[${int64IDs.join(',')}]`;
  }

  return {
    profile: input.profile,
    inputStreams,
    uniqueIDs,
    stringIdsSqlLiteral,
    int64IdsSqlLiteral,
    windowStart,
    windowEnd,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateAndNormalize, parseRfc3339WithOffset };
}

if (typeof $input !== 'undefined') {
  return [{ json: validateAndNormalize($input.first().json) }];
}
