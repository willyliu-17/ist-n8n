function buildEventQueryItems(carrier) {
  if (!carrier || carrier.kind !== 'carrier' || carrier.nextStage !== 'inference') {
    throw new Error('event query requires inference owner carrier');
  }

  return carrier.input.streams.map((stream, index) => {
    const userID = typeof stream.streamContext?.userID === 'string'
      ? stream.streamContext.userID.trim()
      : '';
    if (!userID) {
      throw new Error(`streams[${index}].streamContext.userID must be a non-empty string`);
    }
    return {
      kind: 'event_query',
      carrier,
      liveStreamID: stream.liveStreamID,
      userID,
      beginTime: stream.streamContext.beginTime,
      endTime: stream.streamContext.endTime,
    };
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildEventQueryItems };
}

if (typeof $input !== 'undefined') {
  return buildEventQueryItems($input.first().json).map((json) => ({ json }));
}
