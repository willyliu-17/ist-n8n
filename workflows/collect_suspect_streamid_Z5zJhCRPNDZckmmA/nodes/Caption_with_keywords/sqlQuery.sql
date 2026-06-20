DECLARE timeRegion STRING DEFAULT 'Asia/Taipei';
DECLARE searchKeywords STRING DEFAULT r'{{ $json.searchKeywords || "卡了|重開|當機" }}';

DECLARE intervalDay INT64 DEFAULT {{
    (() => {
      try {
        const manualInterval = $('Manually trigger').item.json.manualInterval;
        if (manualInterval && !isNaN(manualInterval)) {
          return parseInt(manualInterval); 
        }
      } catch (e) {}
      return 1;
    })()
}};

-- [Time Range Settings]
DECLARE queryEndDate TIMESTAMP DEFAULT TIMESTAMP_TRUNC(
  {{
    (() => {
      try {
        const manualTime = $('Manually trigger').item.json.timestamp
        if (manualTime) {
          return `TIMESTAMP("${manualTime}")`; 
        }
      } catch (e) {}
      return 'CURRENT_TIMESTAMP()';
    })()
  }},
  DAY, timeRegion
) + INTERVAL 4 HOUR;

DECLARE queryStartDate TIMESTAMP DEFAULT TIMESTAMP_SUB(queryEndDate, INTERVAL intervalDay DAY);

WITH
  AllStreamsRanked AS ( 
    SELECT
      userID,
      liveStreamID,
      beginTime,
      endTime,
      closeBy, 
      caption,
      publishSec,
      deviceInfo.type AS deviceType,
      deviceInfo.deviceModel AS deviceModel,
      LAG(endTime, 1) OVER ( 
        PARTITION BY userID 
        ORDER BY beginTime ASC
      ) AS previous_endTime,
      LAG(closeBy, 1) OVER ( 
        PARTITION BY userID 
        ORDER BY beginTime ASC
      ) AS previous_closeBy,
      LAG(liveStreamID, 1) OVER ( 
        PARTITION BY userID 
        ORDER BY beginTime ASC
      ) AS previous_liveStreamID,
      LAG(publishSec, 1) OVER (
        PARTITION BY userID
        ORDER BY beginTime ASC
      ) AS previous_publishSec,
      LAG(deviceInfo.type, 1) OVER (
        PARTITION BY userID
        ORDER BY beginTime ASC
      ) AS previous_deviceType,
      LAG(deviceInfo.deviceModel, 1) OVER (
        PARTITION BY userID
        ORDER BY beginTime ASC
      ) AS previous_deviceModel
    FROM
      `media17-1119.mongodb.LiveStreamV2`
    WHERE 
      TIMESTAMP_SECONDS(beginTime) BETWEEN TIMESTAMP_SUB(queryStartDate, INTERVAL (intervalDay + 10) DAY) AND queryEndDate
      AND beginTime IS NOT NULL
      AND endTime IS NOT NULL
      AND userID IS NOT NULL
  ),

  TargetStreams AS (
    SELECT
      userID,
      liveStreamID AS problematic_streamID,
      DATETIME(TIMESTAMP_SECONDS(beginTime), timeRegion) AS problematic_stream_BeginTime_Taipei,
      caption AS problematic_stream_caption,
      closeBy AS problematic_stream_closeBy,
      publishSec AS problematic_publishSec,
      deviceType AS problematic_deviceType,
      deviceModel AS problematic_deviceModel,

      previous_liveStreamID,
      previous_closeBy,
      previous_publishSec,
      previous_deviceType,
      previous_deviceModel,
      (beginTime - previous_endTime) AS time_diff_seconds,
      DATETIME(TIMESTAMP_SECONDS(previous_endTime), timeRegion) AS previous_stream_EndTime_Taipei
    FROM
      AllStreamsRanked
    WHERE
      TIMESTAMP_SECONDS(beginTime) BETWEEN queryStartDate AND queryEndDate
      AND REGEXP_CONTAINS(caption, searchKeywords)
      AND previous_endTime IS NOT NULL
  )

SELECT
  userID,
  CAST(problematic_streamID AS STRING) AS streamID,
  problematic_stream_caption AS caption,
  problematic_stream_closeBy AS closeBy,
  problematic_publishSec AS publishSec,
  problematic_deviceType AS deviceType,
  problematic_deviceModel AS deviceModel,
  
  previous_liveStreamID AS prevStreamID,
  previous_closeBy AS prevCloseBy,
  previous_publishSec AS prevPublicSec,
  previous_deviceType AS prevDeviceType,
  previous_deviceModel AS prevDeviceModel,
  time_diff_seconds,
  problematic_stream_BeginTime_Taipei
FROM
  TargetStreams
WHERE
  time_diff_seconds < 3600
ORDER BY
  streamID ASC;