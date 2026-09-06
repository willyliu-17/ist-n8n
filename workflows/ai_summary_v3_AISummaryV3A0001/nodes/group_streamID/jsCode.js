function buildInferenceAggregate(input, eventEvidence = []) {
  const streams = input.streams.map((stream) => {
    const evidence = eventEvidence.filter((event) => String(event.liveStreamID || event.LiveStreamID || event.streamID || event.StreamID || '') === stream.liveStreamID);
    const details = [
      { type: 'dialogue', liveStreamID: stream.liveStreamID, role: stream.role, mode: stream.mode, dialogue: stream.dialogue, transcript: stream.transcript },
      { type: 'streamInfo', liveStreamID: stream.liveStreamID, streamInfo: [stream.streamContext] },
    ];
    for (const evidenceType of ['streamerLog', 'streamEventLog']) {
      const logs = evidence.filter((item) => item.evidenceType === evidenceType);
      if (logs.length) details.push({ type: evidenceType, liveStreamID: stream.liveStreamID, logs });
    }
    return { liveStreamID: stream.liveStreamID, details, count: details.length };
  });
  return { requestKey: input.requestKey, coverageStatus: input.coverageStatus, streams };
}
if (typeof module !== 'undefined') module.exports = { buildInferenceAggregate };
if (typeof $input !== 'undefined') {
  const items = $input.all().map(({ json }) => json);
  const carrier = items.find((item) => item && item.kind === 'carrier');
  if (!carrier) throw new Error('inference aggregate requires direct carrier');
  const eventEvidence = items.filter((item) => item && item.kind !== 'carrier');
  return [{ json: { ...carrier, aggregate: buildInferenceAggregate(carrier.input, eventEvidence) } }];
}
