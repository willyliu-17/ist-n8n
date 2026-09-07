function notFoundContext(liveStreamID, originalIndex) {
  return {
    originalIndex,
    inputIndex: originalIndex,
    status: 'not_found',
    source: 'livestream_v2',
    profile: 'stt',
    liveStreamID,
    userID: null,
    openID: null,
    beginTime: null,
    endTime: null,
    duration: null,
    region: null,
    vliverModel: null,
    missingFields: ['liveStreamID'],
    eligible: false,
  };
}

function reassembleContexts(plan, resolverRows) {
  const byID = new Map();
  for (const row of resolverRows || []) {
    if (row?.liveStreamID && !byID.has(row.liveStreamID)) byID.set(row.liveStreamID, row);
  }
  return plan.positions.map((position, originalIndex) => {
    const row = byID.get(position.liveStreamID);
    return row
      ? { ...row, inputIndex: originalIndex, originalIndex }
      : notFoundContext(position.liveStreamID, originalIndex);
  });
}

function eligibilityError(context) {
  if (context && context.status !== 'not_found' && context.eligible === true
    && context.profile === 'stt' && context.source === 'livestream_v2') return null;
  const reasons = [];
  if (!context) reasons.push('resolver context missing');
  else {
    if (context.status) reasons.push(`status=${context.status}`);
    if (context.profile !== 'stt') reasons.push(`profile=${context.profile || 'missing'}`);
    if (context.source !== 'livestream_v2') reasons.push(`source=${context.source || 'missing'}`);
    if (Array.isArray(context.missingFields) && context.missingFields.length) {
      reasons.push(`missingFields=${context.missingFields.join(',')}`);
    }
    if (!reasons.length) reasons.push('resolver marked stream ineligible');
  }
  return `Stream ${context?.liveStreamID || 'unknown'} is not eligible for Summary STT (${reasons.join('; ')})`;
}

function buildReassembledRequests(calls, resolverRows) {
  const grouped = new Map();
  for (const call of calls) {
    const key = call.candidate.candidateKey;
    if (!grouped.has(key)) grouped.set(key, { candidate: call.candidate, positions: call.positions });
  }

  const output = [];
  for (const plan of grouped.values()) {
    const contexts = reassembleContexts(plan, resolverRows);
    for (const position of plan.positions) {
      const context = contexts[position.originalIndex];
      const error = eligibilityError(context);
      output.push({
        candidate: plan.candidate,
        eligibilityError: error || '',
        stream: {
          role: position.role,
          liveStreamID: position.liveStreamID,
          mode: position.mode,
          durationMinutes: 5,
          streamContext: context,
          ...(error ? { sttEligible: false } : {}),
        },
      });
    }
  }
  return output;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildReassembledRequests, eligibilityError, notFoundContext, reassembleContexts };
}

if (typeof $input !== 'undefined') {
  const inputRows = $input.all().map(({ json }) => json);
  if (inputRows.some(({ message }) => message?.ts)) {
    const requests = $('Reassemble Resolver Output').all()
      .map(({ json }) => json)
      .filter(({ stream }) => stream);
    if (requests.length !== inputRows.length) throw new Error('Processing message count mismatch');
    const grouped = new Map();
    requests.forEach((request, index) => {
      const key = request.candidate.summaryRequestKey;
      if (!grouped.has(key)) grouped.set(key, { candidate: request.candidate, streams: [] });
      const processingMessageTS = inputRows[index]?.message?.ts;
      if (!/^\d{10,}\.\d{6}$/.test(processingMessageTS || '')) throw new Error('Invalid persisted processing message timestamp');
      grouped.get(key).streams.push({ ...request.stream, processingMessageTS });
    });
    return [...grouped.values()].map(({ candidate, streams }) => ({ json: {
      requestKey: candidate.summaryRequestKey,
      requestType: 'suspect_summary',
      orderedStreams: streams,
      existingDialogues: {},
      channel: candidate.channel,
      threadTS: candidate.threadTS,
    } }));
  }

  const calls = $('Prepare Resolver Chunks').all().map(({ json }) => json);
  return buildReassembledRequests(calls, inputRows).map((json) => ({ json }));
}
