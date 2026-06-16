// n8n Function node — Stream Command Normalizer (no HTTP calls)
// Input: items from previous Parser, e.g. one item:
// {
//   "routeKey": "stt:stream",
//   "group": "stt",
//   "action": "stream",
//   "args": {},
//   "positionals": ["213065175", "last", "5"],
//   "text": "!stt stream 213065175 last 5"
// }
//
// Output per item:
// {
//   "routeKey": "stt:stream",
//   "group": "stt",
//   "action": "stream",
//   "streamid": "213065175",
//   "mode": "last",                 // "first" | "last"
//   "mins": 5,                      // number
//   "param": "last_mins=5",         // query string for convenience
//   "query": { "last_mins": 5 },    // object form for HTTP Request "Query Parameters"
//   "urlPath": "/stream/213065175/stt", // path you can use in HTTP node
//   "method": "GET"                 // convenience for downstream nodes
// }
//
// Rules / precedence (highest to lowest):
// 1) args.param (raw, e.g. "last_mins=7")
// 2) args.first / args.last (key=value form)
// 3) positionals: [streamid] [first|last] [mins]
// 4) defaults: last_mins=5

function parseNumberMaybe(v, fallback = undefined) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeOne(item) {
  const j = item.json || {};
  if (j.routeKey !== 'stt:stream') return null;

  const args = j.args || {};
  const pos = Array.isArray(j.positionals) ? j.positionals.map(String) : [];

  // 1) streamid: prefer args.stream, then first positional
  let streamid = (args.stream ?? pos[0] ?? '').toString().trim();

  // 2) If user ever put streamID in args.streamid
  if (!streamid && args.streamid) {
    streamid = String(args.streamid).trim();
  }

  if (!streamid) {
    // If we cannot determine streamid, drop this item silently (or emit error)
    return {
      json: {
        error: true,
        message: 'Missing streamid for stt:stream',
        input: j,
      },
    };
  }

  // Default mode/mins
  let mode = 'last';        // "first" | "last"
  let mins = 5;

  // 3) Highest precedence: args.param (raw query string)
  //    If provided, we accept it and skip reconstructing from mode/mins.
  let rawParam = typeof args.param === 'string' ? args.param.trim() : '';

  // 4) If no rawParam, then check explicit args.first / args.last
  if (!rawParam) {
    if (args.first !== undefined) {
      const m = parseNumberMaybe(args.first, undefined);
      if (m !== undefined) {
        mode = 'first';
        mins = m;
      }
    }
    if (args.last !== undefined) {
      const m = parseNumberMaybe(args.last, undefined);
      if (m !== undefined) {
        // If both first/last show up, last wins here; change if you prefer otherwise.
        mode = 'last';
        mins = m;
      }
    }
  }

  // 5) If still no decision and we have positionals like ["213065175","last","5"]
  if (!rawParam && pos.length >= 2) {
    const maybeMode = String(pos[1]).toLowerCase();
    if (maybeMode === 'first' || maybeMode === 'last') {
      mode = maybeMode;
      if (pos.length >= 3) {
        const m = parseNumberMaybe(pos[2], mins);
        if (m !== undefined) mins = m;
      }
    }
  }

  // 6) Build final outputs
  let param = rawParam;
  let query = {};
  if (!param) {
    // Construct from mode/mins
    if (mode === 'first') {
      param = `first_mins=${mins}`;
      query = { first_mins: mins };
    } else {
      param = `last_mins=${mins}`;
      query = { last_mins: mins };
    }
  } else {
    // Also try to reflect rawParam into query object for convenience
    // We only handle the two known keys; others are left out.
    const mFirst = /(?:^|&)\s*first_mins=([^&\s]+)/i.exec(param);
    const mLast = /(?:^|&)\s*last_mins=([^&\s]+)/i.exec(param);
    if (mFirst) {
      const n = parseNumberMaybe(mFirst[1], undefined);
      if (n !== undefined) {
        mode = 'first';
        mins = n;
        query = { first_mins: n };
      }
    } else if (mLast) {
      const n = parseNumberMaybe(mLast[1], undefined);
      if (n !== undefined) {
        mode = 'last';
        mins = n;
        query = { last_mins: n };
      }
    }
  }

  const urlPath = `/stream/${encodeURIComponent(streamid)}/stt`;

  return {
    json: {
      routeKey: j.routeKey,
      group: j.group,
      action: j.action,
      streamid,
      mode,        // "first" | "last"
      mins,        // number
      param,       // e.g. "last_mins=5"
      query,       // e.g. { last_mins: 5 }
      urlPath,     // e.g. "/stream/213065175/stt"
      method: 'GET',
      sttDomain: '35.206.206.41',
      // passthrough if needed:
      // text: j.text,
    },
  };
}

const out = [];
for (const it of items) {
  const r = normalizeOne(it);
  if (r) out.push(r);
}
return out;