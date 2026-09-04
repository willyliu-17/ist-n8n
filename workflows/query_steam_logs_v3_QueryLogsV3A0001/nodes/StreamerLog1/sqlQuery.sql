DECLARE start_timestamp TIMESTAMP;
DECLARE end_timestamp TIMESTAMP;

SET end_timestamp = TIMESTAMP_ADD(TIMESTAMP_SECONDS({{ $json.endTime }}), INTERVAL 5 MINUTE);

SET start_timestamp = TIMESTAMP_SUB(TIMESTAMP_SECONDS({{ $json.beginTime }}), INTERVAL 5 MINUTE);

SELECT 
  DATETIME(ClientTime, "Asia/Taipei") as ClientTimeUTCp8, 
  Type,
  PingMax,
  PingMedian,
  PingSD,
  PingCV,
  BitrateMin,
  BitrateMedian,
  BitrateAverage,
  BitrateSD,
  BitrateCV,
  UnsentCountMax,
  UnsentCountAverage,
  UnsentCountMedian,
  UnsentCountSD,
  ReconnectTimes,
  BroadcastDuration,
  Width,
  Height,
  StartBroadcastTime,
  StartPushTime,
  StartStreamingTime,
  LiveStreamID, -- Do NOT remove it for output check
  OSVersion,
  Device,
  AppVersion,
  UserIP,
  IPRegion,
  NetworkType,
  Carrier,
  Provider,
  HostIP,
  StreamUrl,
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