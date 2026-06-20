DECLARE start_timestamp TIMESTAMP;
DECLARE end_timestamp TIMESTAMP;

SET end_timestamp = TIMESTAMP_ADD(TIMESTAMP_SECONDS({{ $json.endTime }}), INTERVAL 5 MINUTE);

SET start_timestamp = TIMESTAMP_SUB(TIMESTAMP_SECONDS({{ $json.beginTime }}), INTERVAL 5 MINUTE);

SELECT 
  DATETIME(ClientTime, "Asia/Taipei") as ClientTimeUTCp8, 
  LiveStreamID, -- Do NOT remove it for output check
  Type,
  OSVersion,
  Device,
  AppVersion,
  UserIP,
  IPRegion,
  NetworkType,
  Carrier,
  PingMax,
  PingMedian,
  PingSD,
  PingCV,
  Provider,
  HostIP,
  StreamUrl,
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
  ip,
  region,
  deviceID,
  version
FROM `media17-1119.BackendEvent.IstStreamerLog`
WHERE 
  timestamp BETWEEN start_timestamp AND end_timestamp
  AND Suid = "{{ $json.liveStreamID }}"
ORDER BY ClientTime ASC;