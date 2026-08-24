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
  if (!input || typeof input !== 'object' || input.bot_id) return null;
  if (input.channel !== CHANNEL) throw new Error('Slack event channel is not allowed');
  if (!SLACK_TIMESTAMP_PATTERN.test(input.ts || '')) throw new Error('Invalid Slack event timestamp');
  if (!SLACK_TIMESTAMP_PATTERN.test(input.event_ts || '')) throw new Error('Invalid Slack root timestamp');
  const line = collectTextsFromSlackRich(input)
    .flatMap((text) => text.split(/\r?\n/))
    .map((text) => text.trim())
    .find((text) => text.startsWith('!')) || '';
  const parsed = parseCommand(line);
  if (!parsed?.group || !parsed.action) return null;
  return {
    client_msg_id: input.client_msg_id,
    ts: input.ts,
    event_ts: input.event_ts,
    routeKey: `${parsed.group}:${parsed.action}`,
    ...parsed,
    channel: CHANNEL,
    channel_type: input.channel_type,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CHANNEL, collectTextsFromSlackRich, parseBotItem, parseCommand };
}

if (typeof $input !== 'undefined') {
  return $input.all().map(({ json }) => parseBotItem(json)).filter(Boolean).map((json) => ({ json }));
}
