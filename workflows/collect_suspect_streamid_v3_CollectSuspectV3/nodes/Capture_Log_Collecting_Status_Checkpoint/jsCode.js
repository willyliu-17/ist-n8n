const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d{6}$/;

function captureLogCollectingStatusCheckpoint(response, carrier) {
  const channel = carrier?.channel;
  const threadTS = carrier?.threadTS;
  const candidateKey = carrier?.candidateKey;
  const messageTimestamp = response?.message_timestamp;
  const responseThreadTS = response?.message?.thread_ts;

  if (typeof candidateKey !== 'string' || !candidateKey
    || typeof channel !== 'string' || !channel
    || typeof threadTS !== 'string' || !SLACK_TIMESTAMP_PATTERN.test(threadTS)) {
    throw new Error('Log collecting status carrier is invalid');
  }
  if (response?.ok !== true || response?.channel !== channel
    || typeof messageTimestamp !== 'string' || !SLACK_TIMESTAMP_PATTERN.test(messageTimestamp)) {
    throw new Error('Log collecting status response is invalid');
  }
  if (responseThreadTS !== undefined && (
    typeof responseThreadTS !== 'string' || responseThreadTS !== threadTS
  )) {
    throw new Error('Log collecting status response thread does not match its carrier');
  }

  return {
    carrier: { candidateKey, channel, threadTS },
    checkpoint: {
      channel,
      messageTimestamp,
      ...(responseThreadTS === undefined ? {} : { responseThreadTS }),
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { captureLogCollectingStatusCheckpoint };
}

if (typeof $input !== 'undefined') {
  return $input.all().map((item, index) => {
    const carrier = $('Build Log Collecting Status').itemMatching(index).json;
    return {
      json: captureLogCollectingStatusCheckpoint(item.json, carrier),
      pairedItem: { item: index },
    };
  });
}
