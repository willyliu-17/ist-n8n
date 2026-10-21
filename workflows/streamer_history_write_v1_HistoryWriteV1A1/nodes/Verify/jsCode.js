// Pure history contracts shared by generated workflow nodes and offline tests.
const History = (() => {
  const PREFIX = 'streamer_history_';
  const TABLES = { events: `${PREFIX}events_v1`, streams: `${PREFIX}event_streams_v1`, analyses: `${PREFIX}analyses_v1`, state: `${PREFIX}import_state_v1`, reviews: `${PREFIX}reviews_v1` };
  const CATEGORY_TABLE = `${PREFIX}analysis_categories_v1`;
  const CHANNEL = 'C09F0SYG57D';
  const CUTOFF = '2026-09-07T16:00:00.000Z';
  const THERMAL = '[1-a] High CPU/Overheating';
  const fail = code => { throw new Error(`history_${code}`); };
  const json = (value, fallback) => {
    if (value === '' || value == null) return fallback;
    try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return fail('invalid_json'); }
  };
  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  // These compact routing keys are not security hashes. Immutable readback detects collisions.
  function fingerprint(value) {
    let a = 2166136261, b = 3339675911;
    for (let i = 0; i < value.length; i++) {
      a = Math.imul(a ^ value.charCodeAt(i), 16777619) >>> 0;
      b = Math.imul(b ^ value.charCodeAt(value.length - i - 1), 2246822519) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
  const key = (kind, parts) => `${kind}:v1:${fingerprint(canonical(parts))}`;
  const selfLinked = r => !!r && r.reconciliationStatus === 'canonical' && String(r.canonicalRowID) === String(r.id) && !!r.id;
  const date = v => Number.isFinite(Date.parse(v)) ? Date.parse(v) : fail('invalid_date');
  const user = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : fail('invalid_user_id');
  const string = v => v == null ? '' : String(v);
  const escape = v => string(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const needsJobContext = r => json(r.orderedStreamsJson, []).some(s => !s.streamContext?.userID);
  function filterSource(r) {
    return selfLinked(r) && r.channel === CHANNEL && date(r.createdAtIso) >= date(CUTOFF);
  }
  function identity(r, jobs = []) {
    const ordered = json(r.orderedStreamsJson, []);
    if (!Array.isArray(ordered) || ordered.length < 1 || ordered.length > 2) fail('invalid_streams');
    const normalized = ordered.map(s => {
      const streamID = string(s.liveStreamID);
      if (!/^\d{1,20}$/.test(streamID) || !['previous', 'current'].includes(s.role)) fail('invalid_streams');
      let context = s.streamContext || {};
      const matches = jobs.filter(j => selfLinked(j) && j.requestKey === r.requestKey && string(j.streamID) === streamID && j.role === s.role);
      const contexts = matches.map(j => json(j.streamContextJson, {})).filter(c => c.userID);
      const users = new Set([context.userID, ...contexts.map(c => c.userID)].filter(Boolean));
      if (users.size !== 1) fail(users.size ? 'identity_conflict' : 'missing_user_id');
      if (!context.userID) context = { ...contexts[0], ...context, userID: [...users][0] };
      return { role: s.role, streamID, context, mode: string(s.mode), durationMinutes: s.durationMinutes ?? null };
    });
    normalized.sort((a, b) => (a.role === 'previous' ? 0 : 1) - (b.role === 'previous' ? 0 : 1));
    if (normalized.at(-1).role !== 'current' || new Set(normalized.map(s => s.role)).size !== normalized.length || new Set(normalized.map(s => s.streamID)).size !== normalized.length) fail('invalid_roles');
    const users = new Set(normalized.map(s => user(s.context.userID)));
    if (users.size !== 1) fail('identity_conflict');
    const userID = [...users][0];
    return { userID, streams: normalized, eventKey: key('event', ['production', userID, normalized.map(s => [s.role, s.streamID])]) };
  }
  function link(channel, ts) {
    return /^C[A-Z0-9]+$/.test(channel || '') && /^\d{10,}\.\d{6}$/.test(ts || '')
      ? `https://17media.slack.com/archives/${channel}/p${ts.replace('.', '')}` : '';
  }
  function sourceLink(r) {
    const match = /^bot-summary:(\d{10,}\.\d{6}):/.exec(r.requestKey || '');
    const ts = match?.[1] || r.threadTS;
    return { triggerTS: ts || '', triggerLink: link(r.channel, ts), linkKind: match ? 'command' : r.requestType === 'suspect_summary' ? 'candidate' : 'thread' };
  }
  function operation(table, keyField, values, mutable = []) {
    return { table, keyField, key: values[keyField], values, mutable };
  }
  function records(r, jobs = []) {
    if (!filterSource(r)) return [];
    const { userID, streams, eventKey } = identity(r, jobs);
    const orderedStreamsJson = canonical(streams.map(s => ({ role: s.role, streamID: s.streamID })));
    const ops = [operation(TABLES.events, 'eventKey', { eventKey, identityVersion: '1', userID, orderedStreamsJson })];
    for (const s of streams) {
      const metadata = Object.fromEntries(['beginTime', 'endTime', 'deviceModel', 'deviceType', 'appVersion', 'osVersion', 'region', 'streamMode', 'isOBS'].map(k => [k, string(s.context[k])]));
      ops.push(operation(TABLES.streams, 'eventStreamKey', {
        eventStreamKey: key('stream', [eventKey, s.role, s.streamID]), eventKey, userID, streamID: s.streamID, role: s.role,
        ...metadata,
      }));
    }
    const requestValues = { stateKey: key('request', [r.requestKey]), recordType: 'request', userID, eventKey, sourceRequestKey: r.requestKey, requestCreatedAtIso: r.createdAtIso, sourceUpdatedAtIso: r.updatedAtIso || r.updatedAt, sourceStatus: r.status, ...sourceLink(r), channel: r.channel, threadTS: string(r.threadTS) };
    ops.push(operation(TABLES.state, 'stateKey', requestValues, ['sourceUpdatedAtIso', 'sourceStatus', 'triggerTS', 'triggerLink', 'linkKind', 'threadTS']));
    if (!r.inferenceResultJson) return ops;
    const result = json(r.inferenceResultJson);
    const categories = result?.report?.summary?.responsibility_category_list;
    if (!Array.isArray(categories) || categories.some(c => typeof c !== 'string')) fail('invalid_categories');
    const scope = { declared: result.analysisScope || null, streams: streams.map(s => ({ role: s.role, streamID: s.streamID, mode: s.mode, durationMinutes: s.durationMinutes })) };
    const resultFingerprint = canonical({ result, scope });
    // Raw model input is not reconstructed from a report. Unknown versions remain empty.
    ops.push(operation(TABLES.analyses, 'analysisKey', {
      analysisKey: key('analysis', [r.requestKey, string(r.id), resultFingerprint]), eventKey, userID,
      sourceRequestKey: r.requestKey, sourceRowID: string(r.id), sourceChannel: r.channel, requestCreatedAtIso: r.createdAtIso,
      sourceType: r.requestType, analysisScopeJson: canonical(scope), aiCategoriesJson: canonical([...new Set(categories)].sort()),
      reportJson: canonical(result.report), summaryMarkdown: string(r.summaryMarkdown), resultFingerprint,
      evidenceCompleteness: 'report_only', evidenceRef: '', evidenceHash: '', promptVersion: '', modelVersion: '', taxonomyVersion: 'legacy-combined-cpu-thermal',
      ...sourceLink(r), summaryMessageTS: string(r.summaryMessageTS), summaryUploadID: string(r.summaryUploadID),
    }, ['summaryMessageTS', 'summaryUploadID']));
    return ops;
  }
  function triggerKind(r, provenance = [], userID) {
    const markers = provenance.filter(n => n.sourceRequestKey === r.requestKey);
    if (markers.length > 1 || markers.some(n => !selfLinked(n) || n.recordType !== 'notification' || n.triggerKind !== 'daily' || n.channel !== r.channel || n.threadTS !== r.threadTS || n.userID !== (userID || identity(r).userID))) fail('trigger_provenance_conflict');
    if (markers.length) return 'daily';
    return r.requestType === 'standalone_summary' && /^bot-summary:\d{10,}\.\d{6}:/.test(r.requestKey) ? 'manual' : 'unknown';
  }
  const dayTW = iso => new Date(date(iso) + 8 * 3600000).toISOString().slice(0, 10);
  function categoryRecords(r, operations, provenance = []) {
    const analysis = operations.find(op => op.table === TABLES.analyses)?.values;
    if (!analysis) return [];
    const messageAt = /^\d{10,}\.\d{6}$/.test(r.summaryMessageTS || '') ? new Date(Number(r.summaryMessageTS) * 1000).toISOString() : '';
    const metadata = {
      analysisKey: analysis.analysisKey, eventKey: analysis.eventKey, userID: analysis.userID,
      sourceRequestKey: r.requestKey, sourceType: r.requestType, triggerKind: triggerKind(r, provenance, analysis.userID), sourceChannel: r.channel,
      requestCreatedAtIso: r.createdAtIso, requestDateTW: dayTW(r.createdAtIso),
      summaryMessageAtIso: messageAt, summaryMessageDateTW: messageAt ? dayTW(messageAt) : '',
      summaryCompletedAtIso: '', completionTimeEvidence: 'not_recorded', sourceStatus: r.status,
      orderedStreamsJson: operations.find(op => op.table === TABLES.events).values.orderedStreamsJson,
      currentStreamID: operations.find(op => op.table === TABLES.streams && op.values.role === 'current').values.streamID,
      analysisScopeJson: analysis.analysisScopeJson, evidenceCompleteness: analysis.evidenceCompleteness,
    };
    return json(analysis.aiCategoriesJson).map(category => operation(CATEGORY_TABLE, 'categoryKey', {
      categoryKey: key('category', [analysis.analysisKey, category]), category, ...metadata,
    }, ['triggerKind', 'summaryMessageAtIso', 'summaryMessageDateTW', 'sourceStatus']));
  }
  function deliveryDecision(r, n) {
    if (!r || r.status !== 'completed' || !r.summaryMessageTS || !r.summaryUploadID) return { action: 'wait' };
    if (!filterSource(r) || n.recordType !== 'notification' || n.triggerKind !== 'daily' || r.channel !== n.channel || r.threadTS !== n.threadTS || r.requestKey !== n.sourceRequestKey || identity(r).userID !== n.userID) fail('delivery_identity_conflict');
    const categories = json(r.inferenceResultJson)?.report?.summary?.responsibility_category_list;
    if (!Array.isArray(categories) || categories.some(c => typeof c !== 'string')) fail('invalid_categories');
    return categories.includes(THERMAL)
      ? { action: 'lookup', userID: n.userID, presentationMode: 'daily_completed', thermalOnly: true, beforeIso: r.createdAtIso, excludeRequestKey: r.requestKey }
      : { action: 'skip' };
  }
  function planWrite(op, rows, nowIso) {
    if (![...Object.values(TABLES), CATEGORY_TABLE].includes(op.table) || op.table === TABLES.reviews || !op.key || op.values?.[op.keyField] !== op.key) fail('invalid_write');
    if (Object.keys(op.values).some(k => ['id', 'createdAt', 'updatedAt', 'canonicalRowID', 'reconciliationStatus'].includes(k))) fail('system_column_write');
    if (Object.values(op.values).some(v => !['string', 'number', 'boolean'].includes(typeof v))) fail('nonprimitive_column');
    const found = rows.filter(r => r.id);
    if (found.length > 1) fail('duplicate_key');
    const observedValues = row => op.table === TABLES.events ? {
      ...op.values,
      firstSeenAtIso: row?.firstSeenAtIso || nowIso,
      lastSeenAtIso: row?.lastSeenAtIso && date(row.lastSeenAtIso) > date(nowIso) ? row.lastSeenAtIso : nowIso,
    } : op.values;
    if (!found.length) {
      if (op.expected) fail('cas_snapshot_missing');
      return { action: 'insert', values: { ...observedValues(), reconciliationStatus: 'pending', canonicalRowID: '', updatedAtIso: nowIso }, conditions: [] };
    }
    const row = found[0];
    if (op.table === CATEGORY_TABLE && row.triggerKind && row.triggerKind !== 'unknown' && row.triggerKind !== op.values.triggerKind) fail('trigger_provenance_regression');
    if (op.expected && Object.entries(op.expected).some(([k, v]) => row[k] !== v)) fail('cas_snapshot_changed');
    if (row[op.keyField] !== op.key || !(selfLinked(row) || (row.reconciliationStatus === 'pending' && !row.canonicalRowID))) fail('invalid_canonical');
    for (const [k, v] of Object.entries(op.values)) {
      if (op.createOnly && ['deliveryStatus', 'deliveryToken', 'deliveryMessageTS'].includes(k)) continue;
      if (!op.mutable.includes(k) && row[k] !== v) fail('immutable_conflict');
    }
    if (op.createOnly && selfLinked(row)) return { action: 'noop', row };
    if (selfLinked(row) && Object.entries(observedValues(row)).every(([k, v]) => row[k] === v)) return { action: 'noop', row };
    for (const field of ['sourceUpdatedAtIso', 'watermarkUpdatedAtIso']) {
      if (op.values[field] && row[field] && date(op.values[field]) < date(row[field])) fail('stale_source');
    }
    // Use the exact custom ISO snapshot; SQLite system timestamps are normalized on read.
    const conditions = Object.entries(row).filter(([k]) => !['createdAt', 'updatedAt'].includes(k)).map(([keyName, value]) => ({ keyName, condition: value == null ? 'isEmpty' : 'eq', ...(value == null ? {} : { keyValue: value }) }));
    return { action: 'update', values: { ...observedValues(row), reconciliationStatus: 'canonical', canonicalRowID: string(row.id), updatedAtIso: nowIso }, snapshot: row, conditions };
  }
  function verifyWrite(op, rows) {
    const found = rows.filter(r => r.id);
    if (found.length !== 1 || !selfLinked(found[0]) || Object.entries(op.values).some(([k, v]) => found[0][k] !== v)) fail('write_not_verified');
    return found[0];
  }
  function resolveReviews(analyses, reviews, analysisKey) {
    const byAnalysis = new Map(analyses.map(a => [a.analysisKey, a]));
    const valid = reviews.filter(r => selfLinked(r) && byAnalysis.has(r.analysisKey));
    const byID = new Map(valid.map(r => [r.reviewID, r]));
    if (byID.size !== valid.length) fail('review_conflict');
    for (const r of valid) {
      if (r.eventKey !== byAnalysis.get(r.analysisKey).eventKey) fail('review_identity_conflict');
      const seen = new Set([r.reviewID]); let target = r.supersedesReviewID;
      while (target) {
        const prior = byID.get(target);
        if (!prior || prior.eventKey !== r.eventKey || seen.has(target)) fail('review_supersedes_invalid');
        seen.add(target); target = prior.supersedesReviewID;
      }
    }
    const superseded = new Set(valid.map(r => r.supersedesReviewID).filter(Boolean));
    let active = valid.filter(r => !superseded.has(r.reviewID));
    active = active.filter(r => r.reviewType !== 'accept_ai' || !active.some(other => other.analysisKey === r.analysisKey && other.reviewType === 'reclassify'));
    if (analysisKey) active = active.filter(r => r.reviewType === 'reclassify' || r.analysisKey === analysisKey);
    const categories = active.map(r => {
      if (!['accept_ai', 'reclassify'].includes(r.reviewType)) fail('invalid_review');
      const values = json(r.humanCategoriesJson, null);
      if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) fail('invalid_review');
      if (r.reviewType === 'accept_ai' && canonical([...new Set(values)].sort()) !== byAnalysis.get(r.analysisKey).aiCategoriesJson) fail('review_accept_mismatch');
      return canonical([...new Set(values)].sort());
    });
    return { reviewed: active.length > 0, conflict: new Set(categories).size > 1, categories: categories.length ? json(categories[0]) : [] };
  }
  function lookup(input, data) {
    const userID = user(input.userID);
    for (const [kind, keyField] of Object.entries({ events: 'eventKey', streams: 'eventStreamKey', analyses: 'analysisKey', state: 'stateKey', reviews: 'reviewID' })) {
      const seen = new Set();
      for (const row of data[kind].filter(selfLinked)) {
        if (seen.has(row[keyField])) fail('duplicate_key');
        seen.add(row[keyField]);
      }
    }
    const cutoff = input.beforeIso ? date(input.beforeIso) : Infinity;
    const allAnalyses = data.analyses.filter(a => selfLinked(a) && a.userID === userID && a.sourceChannel === CHANNEL && a.sourceRequestKey !== input.excludeRequestKey && date(a.requestCreatedAtIso) < cutoff);
    const thermalOnly = input.thermalOnly === true;
    const analyses = thermalOnly ? allAnalyses.filter(a => {
      const review = resolveReviews(allAnalyses.filter(other => other.eventKey === a.eventKey), data.reviews.filter(r => r.eventKey === a.eventKey), a.analysisKey);
      return review.reviewed ? !review.conflict && review.categories.includes(THERMAL) : json(a.aiCategoriesJson).includes(THERMAL);
    }) : allAnalyses;
    const requests = thermalOnly ? [] : data.state.filter(r => selfLinked(r) && r.recordType === 'request' && r.userID === userID && r.sourceRequestKey !== input.excludeRequestKey && date(r.requestCreatedAtIso) < cutoff);
    const eventIDs = new Set([...analyses, ...requests].map(a => a.eventKey));
    const events = data.events.filter(e => selfLinked(e) && e.userID === userID && eventIDs.has(e.eventKey));
    if (events.length !== eventIDs.size) fail('index_incomplete');
    const streams = data.streams.filter(s => selfLinked(s) && s.userID === userID && eventIDs.has(s.eventKey));
    for (const e of events) {
      for (const s of json(e.orderedStreamsJson, [])) {
        if (streams.filter(row => row.eventKey === e.eventKey && row.role === s.role && row.streamID === s.streamID).length !== 1) fail('index_incomplete');
      }
    }
    const eventByKey = new Map(events.map(e => [e.eventKey, e]));
    const dt = v => new Date(v).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    const lines = [];
    const reviewed = new Map();
    for (const e of events) reviewed.set(e.eventKey, resolveReviews(allAnalyses.filter(a => a.eventKey === e.eventKey), data.reviews.filter(r => r.eventKey === e.eventKey)));
    const sorted = [...analyses.map(a => ({ ...a, hasResult: true })), ...requests.filter(r => !analyses.some(a => a.sourceRequestKey === r.sourceRequestKey)).map(r => ({ ...r, hasResult: false }))]
      .sort((a, b) => b.requestCreatedAtIso.localeCompare(a.requestCreatedAtIso) || string(a.analysisKey).localeCompare(string(b.analysisKey)));
    const presentedEvents = new Set();
    for (const a of sorted) {
      if (thermalOnly && input.presentationMode === 'daily_completed' && presentedEvents.has(a.eventKey)) continue;
      presentedEvents.add(a.eventKey);
      const e = eventByKey.get(a.eventKey);
      const ids = json(e.orderedStreamsJson).map(s => s.streamID).join(' → ');
      const review = resolveReviews(allAnalyses.filter(row => row.eventKey === a.eventKey), data.reviews.filter(r => r.eventKey === a.eventKey), a.analysisKey);
      const original = a.hasResult ? json(a.aiCategoriesJson).join('、') : '';
      const label = !a.hasResult ? `處理狀態：${escape(a.sourceStatus)}` : review.conflict ? `人工判定有歧異；原 AI：${escape(original)}` : review.reviewed ? `人工分類：${escape(review.categories.join('、'))}；原 AI：${escape(original)}` : `僅 AI 判讀：${escape(original)}`;
      const trigger = a.triggerLink && /^https:\/\/17media\.slack\.com\/archives\/C[A-Z0-9]+\/p\d+$/.test(a.triggerLink) ? `<${a.triggerLink}|${a.linkKind === 'thread' ? '討論串' : '原觸發訊息'}>` : '觸發連結缺漏';
      const devices = [...new Set(streams.filter(s => s.eventKey === a.eventKey).map(s => [s.deviceModel || '機型缺漏', s.appVersion || 'App 版本缺漏', s.osVersion || 'OS 版本缺漏'].join(' / ')))].map(escape).join('；');
      const repeated = analyses.filter(row => row.eventKey === a.eventKey).length > 1 ? '\n同事件的多次分析／版本，不另計事故。' : '';
      const shared = streams.some(s => s.eventKey === a.eventKey && streams.some(other => other.eventKey !== s.eventKey && other.streamID === s.streamID)) ? '\n與其他事件視角包含相同直播，不能相加為獨立事故。' : '';
      const daily = data.state.some(r => selfLinked(r) && r.recordType === 'notification' && r.triggerKind === 'daily' && r.sourceRequestKey === a.sourceRequestKey);
      const source = daily ? 'daily' : a.sourceType === 'standalone_summary' && /^bot-summary:/.test(a.sourceRequestKey) ? '正式手動 summary' : '觸發方式未知';
      lines.push(`${dt(a.requestCreatedAtIso)}（請求時間，台北）\n來源：${source}\nStreamID：${ids}${json(e.orderedStreamsJson).length > 1 ? '（雙場事件整體分類）' : ''}\n${label}\n${devices}\n${trigger}${repeated}${shared}`);
    }
    const thermalEvents = events.filter(e => {
      if (thermalOnly) return true;
      const r = reviewed.get(e.eventKey);
      return r.reviewed ? !r.conflict && r.categories.includes(THERMAL) : analyses.some(a => a.eventKey === e.eventKey && json(a.aiCategoriesJson).includes(THERMAL));
    }).length;
    const watermarks = data.state.filter(s => s.recordType === 'watermark');
    if (watermarks.length > 1 || watermarks.some(s => !selfLinked(s))) fail('watermark_conflict');
    const watermark = watermarks[0];
    const ready = !!watermark && (input.presentationMode !== 'daily_completed' || date(watermark.watermarkUpdatedAtIso) >= cutoff);
    const header = `${thermalOnly ? '主播過往高 CPU／過熱相關歷史' : '主播過往分析歷史'}\nuserID：${escape(userID)}\n事件視角 ${events.length}；不同直播 ${new Set(streams.map(s => s.streamID)).size}；分析結果 ${analyses.length}\n曾有高 CPU／過熱相關分類的事件視角：${thermalEvents}（非獨立事故數、非確認過熱）\n索引更新：${watermark?.watermarkUpdatedAtIso ? dt(watermark.watermarkUpdatedAtIso) : '尚未完成回填'}`;
    const max = input.presentationMode === 'daily_completed' ? 3 : lines.length;
    const selected = lines.slice(0, max);
    const pages = []; let text = header;
    for (const line of selected) {
      if (text.length + line.length > 2800) { pages.push(text); text = `主播歷史（續）\nuserID：${escape(userID)}`; }
      text += `\n\n${line}`;
    }
    if (!lines.length) text += ready ? thermalOnly ? '\n查無過往高 CPU／過熱相關紀錄。' : '\n此範圍尚無已分析歷史。' : '\n歷史索引尚未就緒，不能判定沒有歷史。';
    if (lines.length > selected.length) text += `\n尚有 ${lines.length - selected.length} 筆未列出。`;
    pages.push(text);
    return { userID, historyStatus: ready ? 'ok' : 'not_ready', pages, eventCount: events.length, analysisCount: analyses.length, thermalEvents };
  }
  return { TABLES, CATEGORY_TABLE, CHANNEL, CUTOFF, THERMAL, key, json, canonical, selfLinked, filterSource, needsJobContext, identity, sourceLink, records, triggerKind, categoryRecords, deliveryDecision, operation, planWrite, verifyWrite, resolveReviews, lookup };
})();
if (typeof module !== 'undefined') module.exports = History;

return [{json:History.verifyWrite($('Input').first().json,$input.all().map(i=>i.json))}];
