const CHANNEL = 'C0A4JJJKJMD';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const STREAM_ID_PATTERN = /^[0-9]{1,20}$/;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatAtOffset(timestamp, offsetMinutes, offset) {
  const local = new Date(timestamp + offsetMinutes * 60 * 1000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
    + `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offset}`;
}

function parseRfc3339(value, fieldName) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/.exec(value || '');
  if (!match) throw new Error(`${fieldName} must be an RFC3339 timestamp with offset`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${fieldName} is invalid`);
  const offsetMinutes = match[7] === 'Z' ? 0 : (match[8] === '-' ? -1 : 1) * (Number(match[9]) * 60 + Number(match[10]));
  return { timestamp, offsetMinutes, offset: match[7] };
}

function buildLookupWindow({ date, nowIso } = {}) {
  if (date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) throw new Error('date must match YYYY-MM-DD');
    const [year, month, day] = match.slice(1).map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw new Error('date is invalid');
    const next = new Date(Date.UTC(year, month - 1, day + 1, 4));
    return {
      start: `${year}-${pad(month)}-${pad(day)}T04:00:00+08:00`,
      end: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T04:00:00+08:00`,
    };
  }
  const current = parseRfc3339(nowIso || formatAtOffset(Date.now(), 480, '+08:00'), 'nowIso');
  return {
    start: formatAtOffset(current.timestamp - 30 * DAY_MS, current.offsetMinutes, current.offset),
    end: formatAtOffset(current.timestamp, current.offsetMinutes, current.offset),
  };
}

function buildSingleStreamLookupWindow({ date, nowIso } = {}) {
  if (!date) return buildLookupWindow({ nowIso });
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('date must match YYYY-MM-DD');
  const [year, month, day] = match.slice(1).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw new Error('date is invalid');
  const start = new Date(Date.UTC(year, month - 1, day - 2, 4));
  const end = new Date(Date.UTC(year, month - 1, day + 3, 4));
  return {
    start: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}T04:00:00+08:00`,
    end: `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}T04:00:00+08:00`,
  };
}

function extendPairingWindow(baseWindow, pairing = {}) {
  const start = parseRfc3339(baseWindow?.start, 'baseWindow.start');
  const end = parseRfc3339(baseWindow?.end, 'baseWindow.end');
  const baseDuration = end.timestamp - start.timestamp;
  if (baseDuration <= 0 || baseDuration > 30 * DAY_MS) throw new Error('baseWindow must be ordered and at most 30 days');
  let startValue = baseWindow.start;
  let endValue = baseWindow.end;
  if (pairing.previousBegin) {
    const previous = parseRfc3339(pairing.previousBegin, 'pairing.previousBegin');
    const bounded = Math.max(previous.timestamp, start.timestamp - 6 * HOUR_MS);
    if (previous.timestamp < start.timestamp) startValue = bounded === previous.timestamp ? pairing.previousBegin : formatAtOffset(bounded, start.offsetMinutes, start.offset);
  }
  if (pairing.currentEnd) {
    const current = parseRfc3339(pairing.currentEnd, 'pairing.currentEnd');
    const bounded = Math.min(current.timestamp, end.timestamp + 6 * HOUR_MS);
    if (current.timestamp > end.timestamp) endValue = bounded === current.timestamp ? pairing.currentEnd : formatAtOffset(bounded, end.offsetMinutes, end.offset);
  }
  const maximumDuration = baseDuration <= DAY_MS ? 36 * HOUR_MS : 31 * DAY_MS;
  if (Date.parse(endValue) - Date.parse(startValue) > maximumDuration) throw new Error('Pairing window exceeds its resolver limit');
  return { start: startValue, end: endValue };
}

function buildPreviousFallbackWindow(baseWindow, days = 30) {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('previous fallback days must be 1..30');
  const start = parseRfc3339(baseWindow?.start, 'baseWindow.start');
  return { start: formatAtOffset(start.timestamp - days * DAY_MS, start.offsetMinutes, start.offset), end: baseWindow.start };
}

function chunkIDs(ids, size = 100) {
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error('chunk size must be 1..100');
  const unique = [...new Set((ids || []).map(String))];
  return Array.from({ length: Math.ceil(unique.length / size) }, (_, index) => unique.slice(index * size, (index + 1) * size));
}

function buildSummaryResolverCalls({ ids, lookupWindow, phase = 'final' }) {
  return chunkIDs(ids).map((chunk, chunkIndex) => ({
    phase,
    chunkIndex,
    streams: chunk.map((liveStreamID) => ({ liveStreamID })),
    lookupWindow,
    profile: 'stt',
  }));
}

function normalizeSummaryCommand(input, nowIso) {
  if (input?.routeKey !== 'summary:stream') throw new Error('Expected summary:stream command');
  if (input.channel !== CHANNEL) throw new Error('Summary channel is not allowed');
  const threadTS = input.thread_ts ?? input.ts;
  if (!/^\d{10,}\.\d{6}$/.test(threadTS || '')) throw new Error('Summary thread timestamp is invalid');
  if (!Array.isArray(input.positionals) || ![1, 2].includes(input.positionals.length)) throw new Error('Summary requires one or two stream IDs');
  const ids = input.positionals.map((value) => String(value).trim());
  if (ids.some((value) => !STREAM_ID_PATTERN.test(value))) throw new Error('Summary stream IDs must be numeric strings');
  const singleStream = ids.length === 1;
  const lookupWindow = singleStream
    ? buildSingleStreamLookupWindow({ date: input.args?.date || '', nowIso })
    : buildLookupWindow({ date: input.args?.date || '', nowIso });
  if (singleStream) {
    return {
      requestKey: `bot-summary:${input.ts}:${ids[0]}`,
      requestType: 'single_stream_summary',
      channel: CHANNEL,
      threadTS,
      date: input.args?.date || '',
      lookupWindow,
      positions: [{ originalIndex: 0, role: 'current', liveStreamID: ids[0], mode: 'fromStart' }],
    };
  }
  return {
    requestKey: `bot-summary:${input.ts}:${ids.join(':')}`,
    requestType: 'standalone_summary',
    channel: CHANNEL,
    threadTS,
    date: input.args?.date || '',
    lookupWindow,
    previousFallbackWindow: buildPreviousFallbackWindow(lookupWindow),
    positions: [
      { originalIndex: 0, role: 'previous', liveStreamID: ids[0], mode: 'fromEnd' },
      { originalIndex: 1, role: 'current', liveStreamID: ids[1], mode: 'fromStart' },
    ],
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildLookupWindow,
    buildSingleStreamLookupWindow,
    buildPreviousFallbackWindow,
    buildSummaryResolverCalls,
    chunkIDs,
    extendPairingWindow,
    normalizeSummaryCommand,
  };
}

if (typeof $input !== 'undefined') {
  const plan = normalizeSummaryCommand($input.first().json);
  const ids = plan.positions.map(({ liveStreamID }) => liveStreamID);
  const calls = buildSummaryResolverCalls({ ids, lookupWindow: plan.lookupWindow, phase: 'base_discovery' });
  return calls.map((call) => ({ json: { ...call, plan } }));
}
