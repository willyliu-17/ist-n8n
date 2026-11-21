const CHANNEL_COMMANDS = Object.freeze({
  C0A4JJJKJMD: Object.freeze({
    'stt:ping': true,
    'stt:stream': true,
    'log:stream': true,
    'summary:stream': true,
    'history:streamer': true,
    'vds:stream': true,
  }),
  C09F0SYG57D: Object.freeze({
    'stt:stream': true,
    'log:stream': true,
    'summary:stream': true,
    'history:streamer': true,
  }),
});
const LEGACY_CHANNEL = 'C09F0SYG57D';
const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d{6}$/;

function renderSectionElements(elements) {
  if (!Array.isArray(elements)) return '';
  return elements.map((el) => {
    if (!el || typeof el !== 'object') return '';
    if (typeof el.text === 'string') return el.text;
    if (typeof el.url === 'string') return el.url;
    if (el.type === 'user' && el.user_id) return `<@${el.user_id}>`;
    if (el.type === 'channel' && el.channel_id) return `<#${el.channel_id}>`;
    return '';
  }).join('');
}

function collectTextsFromSlackRich(root) {
  const texts = [];
  if (!root || typeof root !== 'object') return texts;
  if (root.type === 'rich_text_section' && Array.isArray(root.elements)) {
    const rendered = renderSectionElements(root.elements).trim();
    if (rendered) texts.push(rendered);
    return texts;
  }
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

function unwrapSlackToken(token) {
  if (typeof token !== 'string') return token;
  const match = /^<([^>]+)>$/.exec(token.trim());
  if (!match) return token;
  const inner = match[1];
  const pipeIndex = inner.indexOf('|');
  const target = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
  const label = pipeIndex >= 0 ? inner.slice(pipeIndex + 1) : '';

  if (target.startsWith('tel:')) {
    return label || target.slice(4);
  }
  if (target.startsWith('mailto:')) {
    return label || target.slice(7);
  }
  if (/^https?:\/\//i.test(target)) {
    return target;
  }
  return label || target;
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
    if (separator > 0) {
      const key = token.slice(0, separator).toLowerCase();
      const value = unwrapSlackToken(token.slice(separator + 1));
      args[key] = value;
    } else if (token) {
      positionals.push(unwrapSlackToken(token));
    }
  }
  return {
    group: (match[1] || '').toLowerCase(),
    action: (match[2] || '').toLowerCase(),
    args,
    positionals,
    text: line,
  };
}

function parseBotItem(input, channelCommands = CHANNEL_COMMANDS) {
  const hasWrappedEvent = input && typeof input === 'object' && Object.hasOwn(input, 'event');
  if (hasWrappedEvent && (!input.event || typeof input.event !== 'object' || Array.isArray(input.event))) {
    throw new Error('Slack event must be an object');
  }
  const event = hasWrappedEvent ? input.event : input;
  if (!event || typeof event !== 'object' || event.bot_id || event.subtype) return null;
  if (!Object.hasOwn(channelCommands, event.channel)) return null;
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
  const configured = Object.hasOwn(channelCommands[event.channel], routeKey);
  const enabled = channelCommands[event.channel][routeKey] === true;
  if (configured && !enabled) return null;
  const delivery = enabled ? 'v3' : event.channel === LEGACY_CHANNEL ? 'legacy' : null;
  if (!delivery) return null;
  const fullStream = routeKey === 'stt:stream' && parsed.positionals.length === 1;
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
    ...(routeKey === 'stt:stream' && !fullStream ? {
      sttMode,
      sttMins: Number(parsed.positionals[2] ?? 5),
    } : {}),
    channel: event.channel,
    channel_type: event.channel_type,
    dispatchKey: delivery === 'legacy' ? 'legacy' : `${delivery}:${fullStream ? 'summary:stream' : routeKey}`,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CHANNEL_COMMANDS, LEGACY_CHANNEL, collectTextsFromSlackRich, parseBotItem, parseCommand, unwrapSlackToken };
}

if (typeof $input !== 'undefined') {
  return $input.all().map(({ json }) => parseBotItem(json)).filter(Boolean).map((json) => ({ json }));
}
