DECLARE start_timestamp TIMESTAMP;
DECLARE end_timestamp TIMESTAMP;

SET end_timestamp = TIMESTAMP_ADD(TIMESTAMP_SECONDS({{ $json.endTime }}), INTERVAL 5 MINUTE);
SET start_timestamp = TIMESTAMP_SUB(TIMESTAMP_SECONDS({{ $json.beginTime }}), INTERVAL 5 MINUTE);

SELECT
  'streamEventLog' AS evidenceType,
  DATETIME(timestamp, 'Asia/Taipei') AS UTCp8,
  JSON_EXTRACT_SCALAR(Log, '$.time') AS LocalTime,
  @liveStreamID AS liveStreamID,
  Type,
  JSON_EXTRACT_SCALAR(Log, '$.title') AS title,
  SUBSTR(Log, 1, 32000) AS Log,
  deviceType,
  version
FROM `media17-1119.BackendEvent.IstStreamerEventLog`
WHERE timestamp BETWEEN start_timestamp AND end_timestamp
  AND triggerUserID LIKE CONCAT('%', @userID, '%')
ORDER BY JSON_EXTRACT_SCALAR(Log, '$.time') ASC
