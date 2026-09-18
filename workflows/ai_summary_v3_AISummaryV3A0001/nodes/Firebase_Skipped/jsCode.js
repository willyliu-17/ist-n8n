return $input.all().map(({ json }) => ({
  json: {
    kind: 'firebase_query_skipped',
    liveStreamID: json.liveStreamID,
    platform: json.platform,
    reason: 'unsupported_platform',
  },
}));