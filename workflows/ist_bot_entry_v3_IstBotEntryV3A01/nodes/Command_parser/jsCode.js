const CHANNEL = 'C0A4JJJKJMD';
const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d{6}$/;

function collectTextsFromSlackRich(root) {
  const texts = [];
  if (!root || typeof root !== 'object') return texts;
  if (typeof root.text === 'string') texts.push(root.text);
  if (Array.isArray(root)) {
    for (const value of root) texts.push(...collectTextsFromSlackRich(value));
  } else {
    for (const key of ['blocks', 'elements']) {
      if (Array.isArray(root[key])) texts.push(...collectTextsFromSlackRich(root[key]));
    }
  }
  return texts;
}

function parseCommand(line) {
  const match = /^!\s*([a-zA-Z0-9_]+)(?:\s+([a-zA-Z0-9_]+))?(?:\s+(.*))?$/u.exec(line);
  if (!match) return null;
  const args = {};
  const positionals = [];
  const tokens = (match[3] || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  for (const raw of tokens) {
    const token = raw.replace(/^"|"$/g, '');
    const separator = token.indexOf('=');
    if (separator > 0) args[token.slice(0, separator).toLowerCase()] = token.slice(separator + 1);
    else if (token) positionals.push(token);
  }
  return {
    group: (match[1] || '').toLowerCase(),
    action: (match[2] || '').toLowerCase(),
    args,
    positionals,
    text: line,
  };
}

function parseBotItem(input) {
  const hasWrappedEvent = input && typeof input === 'object' && Object.hasOwn(input, 'event');
  if (hasWrappedEvent && (!input.event || typeof input.event !== 'object' || Array.isArray(input.event))) {
    throw new Error('Slack event must be an object');
  }
  const event = hasWrappedEvent ? input.event : input;
  if (!event || typeof event !== 'object' || event.bot_id || event.subtype) return null;
  if (event.channel !== CHANNEL) throw new Error('Slack event channel is not allowed');
  if (!SLACK_TIMESTAMP_PATTERN.test(event.ts || '')) throw new Error('Invalid Slack event timestamp');
  if (!SLACK_TIMESTAMP_PATTERN.test(event.event_ts || '')) throw new Error('Invalid Slack event timestamp');
  if (event.thread_ts != null && !SLACK_TIMESTAMP_PATTERN.test(event.thread_ts)) throw new Error('Invalid Slack thread timestamp');
  const line = collectTextsFromSlackRich(event)
    .flatMap((text) => text.split(/\r?\n/))
    .map((text) => text.trim())
    .find((text) => text.startsWith('!')) || '';
  const parsed = parseCommand(line);
  if (!parsed?.group || !parsed.action) return null;
  const routeKey = `${parsed.group}:${parsed.action}`;
  const sttMode = parsed.positionals[1] === 'first'
    ? 'fromStart'
    : parsed.positionals[1] === 'last' || !parsed.positionals[1]
      ? 'fromEnd'
      : parsed.positionals[1];
  return {
    client_msg_id: event.client_msg_id,
    ts: event.ts,
    event_ts: event.event_ts,
    thread_ts: event.thread_ts ?? event.ts,
    routeKey,
    ...parsed,
    ...(routeKey === 'stt:stream' ? {
      sttMode,
      sttMins: Number(parsed.positionals[2] ?? 5),
    } : {}),
    channel: CHANNEL,
    channel_type: event.channel_type,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CHANNEL, collectTextsFromSlackRich, parseBotItem, parseCommand };
}

if (typeof $input !== 'undefined') {
  return $input.all().map(({ json }) => parseBotItem(json)).filter(Boolean).map((json) => ({ json }));
}
