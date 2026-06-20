DECLARE timeRegion STRING DEFAULT 'Asia/Taipei';

DECLARE startTime TIMESTAMP DEFAULT TIMESTAMP_SUB(TIMESTAMP_SECONDS({{ $json.beginTime }}), INTERVAL 5 MINUTE);
DECLARE endTime TIMESTAMP DEFAULT TIMESTAMP_ADD(TIMESTAMP_SECONDS({{ $json.endTime }}), INTERVAL 5 MINUTE);

SELECT
  s_streamID, -- Do NOT remove it for output check
  DATETIME(insertTs, "Asia/Taipei") as UTCp8, msg, s_content, s_region, s_reqOpenID, s_reqUserID
FROM
  `media17-1119.eventStreaming.streamComment`
WHERE
  _PARTITIONTIME BETWEEN TIMESTAMP_TRUNC(startTime, DAY) AND TIMESTAMP_TRUNC(endTime, DAY)
  AND insertTs BETWEEN startTime AND endTime
  
  AND s_streamID = "{{ $json.liveStreamID }}" 
ORDER by s_streamID, UTCp8 ASC; 