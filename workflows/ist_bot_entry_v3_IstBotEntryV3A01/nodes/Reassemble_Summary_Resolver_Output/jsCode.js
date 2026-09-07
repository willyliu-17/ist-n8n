function missingContext(liveStreamID, inputIndex) {
  return { inputIndex, status: 'not_found', source: 'livestream_v2', profile: 'stt', liveStreamID, eligible: false };
}

function reassembleSummaryContexts(ids, rows) {
  const byID = new Map();
  for (const row of rows || []) {
    if (row?.liveStreamID && !byID.has(row.liveStreamID)) byID.set(row.liveStreamID, row);
  }
  return ids.map((liveStreamID, inputIndex) => ({ ...(byID.get(liveStreamID) || missingContext(liveStreamID, inputIndex)), inputIndex }));
}

function taipeiRfc3339(epochSeconds, fieldName) {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0) throw new Error(`${fieldName} is invalid`);
  const local = new Date(epochSeconds * 1000 + 8 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
    + `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}+08:00`;
}

function requireEligible(context) {
  if (!context || context.eligible !== true || context.profile !== 'stt' || context.source !== 'livestream_v2') {
    throw new Error(`Stream ${context?.liveStreamID || 'unknown'} is not eligible for Summary STT`);
  }
  return context;
}

function requireEndedSingleStream(context) {
  requireEligible(context);
  if (!Number.isFinite(context.beginTime) || !Number.isFinite(context.endTime) || context.endTime <= context.beginTime) {
    throw new Error(`Stream ${context.liveStreamID} does not have a valid ended time range`);
  }
  if (context.endTime > Math.floor(Date.now() / 1000)) {
    throw new Error(`Stream ${context.liveStreamID} has not ended yet`);
  }
  if (context.closeBy === null || context.closeBy === undefined || (typeof context.closeBy === 'string' && context.closeBy.trim() === '')) {
    throw new Error(`Stream ${context.liveStreamID} does not have a closing marker`);
  }
  return context;
}

function isSingleStreamPlan(plan) {
  return plan?.requestType === 'single_stream_summary';
}

function eligibleContext(rows, liveStreamID) {
  return (rows || []).find((row) => row?.liveStreamID === liveStreamID
    && row.eligible === true && row.profile === 'stt' && row.source === 'livestream_v2');
}

function extendPairingWindow(baseWindow, pairing) {
  const hourMs = 60 * 60 * 1000;
  const startMs = Date.parse(baseWindow.start);
  const endMs = Date.parse(baseWindow.end);
  const previousMs = Date.parse(pairing.previousBegin);
  const currentMs = Date.parse(pairing.currentEnd);
  const start = previousMs < startMs ? new Date(Math.max(previousMs, startMs - 6 * hourMs)) : new Date(startMs);
  const end = currentMs > endMs ? new Date(Math.min(currentMs, endMs + 6 * hourMs)) : new Date(endMs);
  const format = (date) => {
    const local = new Date(date.getTime() + 8 * hourMs);
    const pad = (value) => String(value).padStart(2, '0');
    return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
      + `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}+08:00`;
  };
  return { start: format(start), end: format(end) };
}

function buildSummaryResolverCalls(ids, lookupWindow) {
  const unique = [...new Set(ids)];
  const calls = [];
  for (let index = 0; index < unique.length; index += 100) {
    calls.push({
      phase: 'final',
      chunkIndex: calls.length,
      streams: unique.slice(index, index + 100).map((liveStreamID) => ({ liveStreamID })),
      lookupWindow,
      profile: 'stt',
    });
  }
  return calls;
}

function finalResolutionCalls(plan, previous, current) {
  if (!previous || !current) throw new Error('Summary discovery could not resolve the paired streams');
  const finalLookupWindow = extendPairingWindow(plan.lookupWindow, {
    previousBegin: taipeiRfc3339(previous.beginTime, 'previous.beginTime'),
    currentEnd: taipeiRfc3339(current.endTime, 'current.endTime'),
  });
  const previousBeginMs = previous.beginTime * 1000;
  if (!Number.isSafeInteger(previous.beginTime)
    || previousBeginMs < Date.parse(finalLookupWindow.start)
    || previousBeginMs >= Date.parse(finalLookupWindow.end)) {
    throw new Error('Previous stream is outside the bounded final lookup window');
  }
  return buildSummaryResolverCalls(plan.positions.map(({ liveStreamID }) => liveStreamID), finalLookupWindow)
    .map((call) => ({ ...call, plan: { ...plan, finalLookupWindow } }));
}

function finalSingleResolutionCalls(plan, current) {
  requireEndedSingleStream(current);
  return buildSummaryResolverCalls([plan.positions[0].liveStreamID], plan.lookupWindow)
    .map((call) => ({ ...call, plan }));
}

function planAfterBaseDiscovery(plan, rows) {
  if (isSingleStreamPlan(plan)) {
    const current = eligibleContext(rows, plan.positions[0].liveStreamID);
    if (!current) throw new Error('Summary base discovery could not resolve current stream');
    return finalSingleResolutionCalls(plan, current);
  }
  const previous = eligibleContext(rows, plan.positions[0].liveStreamID);
  const current = eligibleContext(rows, plan.positions[1].liveStreamID);
  if (!current) throw new Error('Summary base discovery could not resolve current stream');
  if (previous) return finalResolutionCalls(plan, previous, current);
  return [{
    phase: 'previous_fallback',
    chunkIndex: 0,
    streams: [{ liveStreamID: plan.positions[0].liveStreamID }],
    lookupWindow: plan.previousFallbackWindow,
    profile: 'stt',
    plan,
  }];
}

function planAfterFallbackDiscovery(plan, baseRows, fallbackRows) {
  const previous = eligibleContext(fallbackRows, plan.positions[0].liveStreamID);
  const current = eligibleContext(baseRows, plan.positions[1].liveStreamID);
  return finalResolutionCalls(plan, previous, current);
}

function buildOrderedSummaryStreams(plan, contexts) {
  return plan.positions.map((position) => {
    const streamContext = isSingleStreamPlan(plan)
      ? requireEndedSingleStream(contexts[position.originalIndex])
      : requireEligible(contexts[position.originalIndex]);
    return {
      role: position.role,
      liveStreamID: position.liveStreamID,
      mode: position.mode,
      durationMinutes: isSingleStreamPlan(plan)
        ? Math.ceil((streamContext.endTime - streamContext.beginTime) / 60)
        : 5,
      streamContext,
    };
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildOrderedSummaryStreams,
    planAfterBaseDiscovery,
    planAfterFallbackDiscovery,
    reassembleSummaryContexts,
  };
}

if (typeof $input !== 'undefined') {
  const rows = $input.all().map(({ json }) => json);
  if (rows.some(({ message }) => message?.ts)) {
    const requests = $('Reassemble Summary Streams').all().map(({ json }) => json);
    if (requests.length !== rows.length) throw new Error('Summary processing message count mismatch');
    const orderedStreams = requests.map((request, index) => {
      const processingMessageTS = rows[index]?.message?.ts;
      if (!/^\d{10,}\.\d{6}$/.test(processingMessageTS || '')) throw new Error('Invalid persisted processing message timestamp');
      return { ...request.stream, processingMessageTS };
    });
    const plan = requests[0].plan;
    return [{ json: {
      requestKey: plan.requestKey,
      requestType: plan.requestType,
      orderedStreams,
      existingDialogues: {},
      channel: plan.channel,
      threadTS: plan.threadTS,
    } }];
  }

  let finalResolverExecuted = false;
  try {
    finalResolverExecuted = $('Resolve Summary Streams').all().length > 0;
  } catch (error) {
    finalResolverExecuted = false;
  }
  if (!finalResolverExecuted) {
    let firstPlans = [];
    try {
      firstPlans = $('Build Summary Resolution Plan').all().map(({ json }) => json);
    } catch (error) {
      firstPlans = [];
    }
    const plan = $('Build Summary Resolver Input').first().json.plan;
    if (firstPlans.some(({ phase }) => phase === 'previous_fallback')) {
      const baseRows = $('Resolve Summary Discovery').all().map(({ json }) => json);
      return planAfterFallbackDiscovery(plan, baseRows, rows).map((json) => ({ json }));
    }
    return planAfterBaseDiscovery(plan, rows).map((json) => ({ json }));
  }

  let finalCalls = [];
  try {
    finalCalls = $('Build Final After Fallback').all().map(({ json }) => json);
  } catch (error) {
    finalCalls = [];
  }
  if (!finalCalls.length) finalCalls = $('Build Summary Resolution Plan').all().map(({ json }) => json);
  const plan = finalCalls[0].plan;
  const contexts = reassembleSummaryContexts(plan.positions.map(({ liveStreamID }) => liveStreamID), rows);
  return buildOrderedSummaryStreams(plan, contexts).map((stream) => ({ json: {
    plan,
    stream,
  } }));
}
