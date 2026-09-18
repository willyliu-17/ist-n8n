function buildEventQueryItems(carrier) {
  if (!carrier || carrier.kind !== 'carrier' || carrier.nextStage !== 'inference') {
    throw new Error('event query requires inference owner carrier');
  }

  const missingRoles = new Set(carrier.input.missingRoles || []);
  return carrier.input.streams.map((stream, index) => {
    const userID = typeof stream.streamContext?.userID === 'string'
      ? stream.streamContext.userID.trim()
      : '';
    const beginTime = stream.streamContext?.beginTime;
    const endTime = stream.streamContext?.endTime;
    if (!userID) {
      if (missingRoles.has(stream.role)) return null;
      throw new Error(`streams[${index}].streamContext.userID must be a non-empty string`);
    }
    if (!Number.isFinite(beginTime) || !Number.isFinite(endTime) || beginTime > endTime) {
      if (missingRoles.has(stream.role)) return null;
      throw new Error(`streams[${index}].streamContext has an invalid event query window`);
    }
    return {
      kind: 'event_query',
      carrier,
      liveStreamID: stream.liveStreamID,
      userID,
      beginTime,
      endTime,
      platform: String(stream.streamContext?.deviceType || '')
        .trim()
        .toUpperCase(),
    };
  }).filter(Boolean);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildEventQueryItems };
}

if (typeof $input !== 'undefined') {
  return buildEventQueryItems($input.first().json).map((json) => ({ json }));
}
