const inputs = $input.all();
const definitions = [
  ['streamerLog', 'StreamerLog'],
  ['streamerEventLog', 'StreamerEventLog'],
  ['streamCommentLog', 'StreamCommentLog'],
  ['matomoLog', 'MatomoLog'],
];
const byKind = new Map(
  inputs
    .filter((item) => typeof item.json?.kind === 'string')
    .map((item) => [item.json.kind, item]),
);
const details = $('steamID beginTime and endTime1').first().json;
const composed = $('compose slack message').first().json;
const logLines = definitions.map(([kind, label]) => (
  byKind.get(kind)?.json.available
    ? `- ${label}: attached`
    : `- No ${label} available for this stream.`
));
const summaryText = [
  '📢 *Stream Log Summary* 📢',
  `- StreamID: \`${details.liveStreamID}\``,
  `- CloseBy: \`${details.closeBy}\``,
  `- duration: \`${details.duration}\``,
  `- deviceInfo: \`${details.type}\`, \`${details.deviceModel}\``,
  composed.slackMessage || '',
  '',
  '*Logs:*',
  ...logLines,
].join('\n');
const files = definitions
  .map(([kind]) => byKind.get(kind))
  .filter((item) => item?.json.available);

if (files.length === 0) {
  return [{ json: { hasFiles: false, summaryText, fileID: {} } }];
}

return files.map((item) => ({
  json: {
    ...item.json,
    hasFiles: true,
    summaryText,
  },
  binary: item.binary,
}));
