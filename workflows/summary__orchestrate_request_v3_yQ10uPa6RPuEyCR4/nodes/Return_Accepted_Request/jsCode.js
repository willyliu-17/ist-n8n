function acceptedResult(request) {
  if (!request || request.reconciliationStatus !== 'canonical') throw new Error('Return requires canonical request');
  return {
    accepted: true,
    requestKey: request.requestKey,
    requestType: request.requestType,
    status: request.status,
    channel: request.channel,
    threadTS: request.threadTS,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { acceptedResult };

if (typeof $input !== 'undefined') return [{ json: acceptedResult($input.first().json) }];
