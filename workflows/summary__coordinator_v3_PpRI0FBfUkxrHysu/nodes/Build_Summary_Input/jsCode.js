function buildSummaryInput(request, aggregate) {
  if (!['complete', 'partial'].includes(aggregate.coverageStatus) || !Array.isArray(aggregate.streams) || aggregate.streams.length === 0) throw new Error('summary input requires usable coverage');
  return { requestKey: request.requestKey, requestType: request.requestType, channel: request.channel, threadTS: request.threadTS, coverageStatus: aggregate.coverageStatus, availableRoles: aggregate.availableRoles, missingRoles: aggregate.missingRoles, failedLogicalJobKeys: aggregate.failedLogicalJobKeys, streams: aggregate.streams.map(({ role, liveStreamID, mode, dialogue, transcript, streamContext }) => ({ role, liveStreamID, mode, dialogue, transcript, streamContext })) };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { buildSummaryInput };
if (typeof $input !== 'undefined') {
  return [{ json: buildSummaryInput($json, $json) }];
}
