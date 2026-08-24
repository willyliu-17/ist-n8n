const carrier = $input.first().json;
if (!carrier || carrier.kind !== 'carrier' || carrier.nextStage !== 'inference') throw new Error('event query requires inference owner carrier');
return carrier.input.streams.map((stream) => ({ json: { kind: 'event_query', carrier, liveStreamID: stream.liveStreamID, beginTime: stream.streamContext.beginTime, endTime: stream.streamContext.endTime } }));
