// n8n Function node — Command Parser (no HTTP)
// - Supports Slack Block Kit rich_text payloads
// - Only returns items for lines starting with "!"
// - Skips messages with json.bot_id

function toArray(x) {
  if (Array.isArray(x)) return x;
  if (x == null) return [];
  return [x];
}

function collectTextsFromSlackRich(root) {
  // Collect plain texts from Slack Block Kit "rich_text" blocks/sections/elements
  const texts = [];

  // Case A: item.json is an array like the provided example
  if (Array.isArray(root)) {
    for (const node of root) {
      if (node && typeof node === 'object') {
        if (node.type === 'rich_text_section' && Array.isArray(node.elements)) {
          for (const el of node.elements) {
            if (el && el.type === 'text' && typeof el.text === 'string') {
              texts.push(el.text);
            }
          }
        } else if (node.type === 'rich_text' && Array.isArray(node.elements)) {
          // Slack "rich_text" can contain sections
          for (const sec of node.elements) {
            if (sec && sec.type === 'rich_text_section' && Array.isArray(sec.elements)) {
              for (const el of sec.elements) {
                if (el && el.type === 'text' && typeof el.text === 'string') {
                  texts.push(el.text);
                }
              }
            }
          }
        }
        // Recurse for nested arrays/objects if present
        if (Array.isArray(node.elements)) {
          texts.push(...collectTextsFromSlackRich(node.elements));
        }
      }
    }
    return texts;
  }

  // Case B: item.json.blocks is standard Slack blocks array
  if (root && Array.isArray(root.blocks)) {
    for (const block of root.blocks) {
      if (!block) continue;
      // rich_text block
      if (block.type === 'rich_text' && Array.isArray(block.elements)) {
        for (const sec of block.elements) {
          if (sec && sec.type === 'rich_text_section' && Array.isArray(sec.elements)) {
            for (const el of sec.elements) {
              if (el && el.type === 'text' && typeof el.text === 'string') {
                texts.push(el.text);
              }
            }
          }
        }
      }
      // section block with text object
      if (block.type === 'section' && block.text && typeof block.text.text === 'string') {
        texts.push(block.text.text);
      }
    }
  }

  return texts;
}

function pickCandidateTexts(j) {
  const out = [];

  // 1) Direct scalar text fields
  for (const k of ['text', 'message', 'content']) {
    if (typeof j[k] === 'string' && j[k].trim() !== '') out.push(j[k]);
  }

  // 2) Slack "blocks"
  out.push(...collectTextsFromSlackRich(j));

  // 3) If the entire payload is an array (Slack rich_text array)
  if (Array.isArray(j)) {
    out.push(...collectTextsFromSlackRich(j));
  }

  return out.filter(s => typeof s === 'string' && s.trim() !== '');
}

function findFirstCommandLineFromTexts(texts) {
  for (const s of texts) {
    const lines = s.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().startsWith('!')) return line.trim();
    }
  }
  return '';
}

function parseCommand(line) {
  // Syntax: "!<group> <action> [tokens...]"
  const m = /^!\s*([a-zA-Z0-9_]+)(?:\s+([a-zA-Z0-9_]+))?(?:\s+(.*))?$/u.exec(line);
  if (!m) return null;
  const group = (m[1] || '').toLowerCase();
  const action = (m[2] || '').toLowerCase();
  const rest = (m[3] || '').trim();

  const args = {};
  const positionals = [];

  if (rest) {
    // Tokenize respecting simple double quotes
    const tokens = [];
    let buf = '';
    let inQuotes = false;
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (!inQuotes && /\s/.test(ch)) {
        if (buf) { tokens.push(buf); buf = ''; }
      } else {
        buf += ch;
      }
    }
    if (buf) tokens.push(buf);

    for (const t of tokens) {
      if (t.includes('=')) {
        const idx = t.indexOf('=');
        const k = t.slice(0, idx).trim().toLowerCase();
        const v = t.slice(idx + 1).trim();
        if (k) args[k] = v;
      } else if (t) {
        positionals.push(t.trim());
      }
    }
  }

  return { group, action, args, positionals, text: line };
}

const CHANNEL = 'C09F0SYG57D';
const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d{6}$/;

function parseBotItem(input) {
  const hasWrappedEvent = input && typeof input === 'object' && Object.hasOwn(input, 'event');
  if (hasWrappedEvent && (!input.event || typeof input.event !== 'object' || Array.isArray(input.event))) {
    throw new Error('Slack event must be an object');
  }
  const j = hasWrappedEvent ? input.event : input;
  // Skip if missing payload
  if (j == null) return null;

  // Skip bot messages
  if (j && typeof j === 'object' && j.bot_id) return null;
  if (j.channel !== CHANNEL) throw new Error('Slack event channel is not allowed');
  if (!SLACK_TIMESTAMP_PATTERN.test(j.ts || '')) throw new Error('Invalid Slack event timestamp');
  if (!SLACK_TIMESTAMP_PATTERN.test(j.event_ts || '')) throw new Error('Invalid Slack event timestamp');
  if (j.thread_ts != null && !SLACK_TIMESTAMP_PATTERN.test(j.thread_ts)) throw new Error('Invalid Slack thread timestamp');

  const texts = pickCandidateTexts(j);
  const cmdLine = findFirstCommandLineFromTexts(texts);
  if (!cmdLine) return null;

  const parsed = parseCommand(cmdLine);
  if (!parsed || !parsed.group || !parsed.action) return null;

  const { group, action, args, positionals, text } = parsed;
  return {
    client_msg_id: j.client_msg_id,
    ts: j.ts,
    event_ts: j.event_ts,
    thread_ts: j.thread_ts ?? j.ts,
    routeKey: `${group}:${action}`,
    group,
    action,
    args,
    positionals,
    text,
    channel: j.channel,
    channel_type: j.channel_type,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CHANNEL, parseBotItem, parseCommand };
}

if (typeof items !== 'undefined') {
  return items.map(({ json }) => parseBotItem(json)).filter(Boolean).map((json) => ({ json }));
}
