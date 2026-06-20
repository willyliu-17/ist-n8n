DECLARE start_timestamp TIMESTAMP;
DECLARE end_timestamp TIMESTAMP;

SET end_timestamp = TIMESTAMP_ADD(TIMESTAMP_SECONDS({{ $json.endTime }}), INTERVAL 5 MINUTE);
SET start_timestamp = TIMESTAMP_SUB(TIMESTAMP_SECONDS({{ $json.beginTime }}), INTERVAL 5 MINUTE);

  SELECT
    DATETIME(timestamp, "Asia/Taipei") as UTCp8, 
    JSON_EXTRACT_SCALAR(Log, '$.time') as LocalTime,
    triggerUserID, -- Do NOT remove it for output check
    Type,
    JSON_EXTRACT_SCALAR(Log, '$.title') AS title, -- Extracts 'title' from the JSON string
    Log,
    deviceType,
    ip,
    region,
    deviceID,
    version,
FROM
    `media17-1119.BackendEvent.IstStreamerEventLog`
WHERE
    timestamp BETWEEN start_timestamp AND end_timestamp
    AND triggerUserID LIKE "%{{ $json.userID }}%"
ORDER BY
    JSON_EXTRACT_SCALAR(Log, '$.time') ASC -- Orders by the 'time' field within the JSON string