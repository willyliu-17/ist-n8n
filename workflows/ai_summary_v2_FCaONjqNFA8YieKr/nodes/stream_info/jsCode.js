const streamInfoItems = $("query stream info").all();
const streamInfo = streamInfoItems.map(item => item.json);
const liveStreamID = (streamInfo[0] && (streamInfo[0].liveStreamID || streamInfo[0].LiveStreamID)) || undefined;

return [
  {
    json: {
      type: 'streamInfo',
      liveStreamID,
      streamInfo,
    }
  }
];