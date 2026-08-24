DECLARE start_timestamp TIMESTAMP;
DECLARE end_timestamp TIMESTAMP;

SET end_timestamp = TIMESTAMP_ADD(TIMESTAMP_SECONDS({{ $json.endTime }}), INTERVAL 5 MINUTE);
SET start_timestamp = TIMESTAMP_SUB(TIMESTAMP_SECONDS({{ $json.beginTime }}), INTERVAL 5 MINUTE);

  SELECT
    'streamEventLog' AS evidenceType,
    DATETIME(timestamp, "Asia/Taipei") as UTCp8,
    JSON_EXTRACT_SCALAR(Log, '$.time') as LocalTime,
    Suid AS liveStreamID,
    Type,
    JSON_EXTRACT_SCALAR(Log, '$.title') AS title, -- Extracts 'title' from the JSON string
    SUBSTR(Log, 1, 32000) AS Log,
    deviceType,
    version
FROM
    `media17-1119.BackendEvent.IstStreamerEventLog`
WHERE
    timestamp BETWEEN start_timestamp AND end_timestamp
    AND Suid = @liveStreamID
ORDER BY
    JSON_EXTRACT_SCALAR(Log, '$.time') ASC -- Orders by the 'time' field within the JSON string
