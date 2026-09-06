=DECLARE start_timestamp TIMESTAMP;
DECLARE end_timestamp TIMESTAMP;

SET end_timestamp = TIMESTAMP_ADD(TIMESTAMP_SECONDS({{ $json.endTime }}), INTERVAL 5 MINUTE);

SET start_timestamp = TIMESTAMP_SUB(TIMESTAMP_SECONDS({{ $json.beginTime }}), INTERVAL 5 MINUTE);

SELECT 
  'streamerLog' AS evidenceType,
  DATETIME(ClientTime, "Asia/Taipei") as ClientTimeUTCp8, 
  @liveStreamID AS liveStreamID,
  Type,
  OSVersion,
  Device,
  AppVersion,
  NetworkType,
  UserIP,
  IPRegion,
  PingMax,
  PingMedian,
  PingSD,
  PingCV,
  Provider,
  BitrateMin,
  BitrateMedian,
  BitrateAverage,
  BitrateSD,
  BitrateCV,
  BroadcastDuration,
  StartBroadcastTime,
  StartPushTime,
  StartStreamingTime,
  ReconnectTimes,
  Width,
  Height,
  UnsentCountMax,
  UnsentCountAverage,
  UnsentCountMedian,
  UnsentCountSD,
  KeepAliveFailCount,
  Event,
  deviceType,
  version
FROM `media17-1119.BackendEvent.IstStreamerLog`
WHERE 
  timestamp BETWEEN start_timestamp AND end_timestamp
  AND Suid = @liveStreamID
ORDER BY ClientTime ASC;
