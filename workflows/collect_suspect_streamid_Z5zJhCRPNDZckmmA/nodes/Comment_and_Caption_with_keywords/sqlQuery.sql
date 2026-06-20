DECLARE timeRegion STRING DEFAULT 'Asia/Taipei';
DECLARE searchKeywords STRING DEFAULT r'{{ $json.searchKeywords || "卡了|重開|當機" }}';

-- [Time Calculation]
DECLARE queryEndDate TIMESTAMP DEFAULT TIMESTAMP_TRUNC(
  {{
    (() => {
      try {
        const manualTime = $('Manually trigger').item.json.timestamp;
        if (manualTime) { return `TIMESTAMP("${manualTime}")`; }
      } catch (e) {}
      return 'CURRENT_TIMESTAMP()';
    })()
  }},
  DAY, "Asia/Taipei"
) + INTERVAL 4 HOUR;

DECLARE queryStartDate TIMESTAMP DEFAULT queryEndDate - INTERVAL {{
    (() => {
      try {
        const manualInterval = $('Manually trigger').item.json.manualInterval;
        if (manualInterval && !isNaN(manualInterval)) { return parseInt(manualInterval); }
      } catch (e) {}
      return 1;
    })()
}} DAY;

-- [Lookback Setting]
DECLARE lookBackStartDate TIMESTAMP DEFAULT queryStartDate - INTERVAL 7 DAY;

WITH
  -- 1. Get RecentComments
  RecentComments AS (
    SELECT
      s_streamID,
      COUNT(1) as comment_count
    FROM
      `media17-1119.eventStreaming.streamComment`
    WHERE
      _PARTITIONTIME BETWEEN TIMESTAMP_TRUNC(queryStartDate, DAY) AND TIMESTAMP_TRUNC(queryEndDate, DAY)
      AND REGEXP_CONTAINS(s_content, searchKeywords)
    GROUP BY s_streamID
  ),

  -- 2. Raw Stream Data (Performance Filter)
  RawStreamsData AS (
    SELECT
      userID,
      liveStreamID,
      beginTime,
      endTime,
      closeBy,
      caption,
      publishSec,
      deviceInfo.type AS deviceType,
      deviceInfo.deviceModel AS deviceModel
    FROM
      `media17-1119.mongodb.LiveStreamV2`
    WHERE
      TIMESTAMP_SECONDS(beginTime) >= lookBackStartDate
      AND TIMESTAMP_SECONDS(beginTime) <= queryEndDate
      AND beginTime IS NOT NULL
      AND endTime IS NOT NULL
  ),

  -- 3. Calculate Previous Stream Info
  RankedStreams AS (
    SELECT
      *,
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
      LAG(deviceType, 1) OVER (
        PARTITION BY userID
        ORDER BY beginTime ASC
      ) AS previous_deviceType,
      LAG(deviceModel, 1) OVER (
        PARTITION BY userID
        ORDER BY beginTime ASC
      ) AS previous_deviceModel
    FROM
      RawStreamsData
  ),

  -- 4. Filter Captions and Restart Logic
  RecentCaptions AS (
    SELECT
      userID,
      liveStreamID AS problematic_streamID,
      DATETIME(TIMESTAMP_SECONDS(beginTime), 'Asia/Taipei') AS problematic_stream_BeginTime_Taipei,
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
      DATETIME(TIMESTAMP_SECONDS(previous_endTime), 'Asia/Taipei') AS previous_stream_EndTime_Taipei
    FROM
      RankedStreams
    WHERE
      TIMESTAMP_SECONDS(beginTime) BETWEEN queryStartDate AND queryEndDate
      AND REGEXP_CONTAINS(caption, searchKeywords)
      AND previous_endTime IS NOT NULL
      AND (beginTime - previous_endTime) < 3600
  )

-- Final Join
SELECT
  cap.userID,
  com.s_streamID AS streamID,
  cap.problematic_stream_caption AS caption,
  cap.problematic_stream_BeginTime_Taipei AS beginTime,
  cap.problematic_publishSec AS publishSec,
  cap.problematic_deviceType AS deviceType,
  cap.problematic_deviceModel AS deviceModel,
  cap.previous_liveStreamID AS prevStreamID,
  cap.previous_closeBy AS prevCloseBy,
  cap.previous_publishSec AS prevPublishSec,
  cap.previous_deviceType AS prevDeviceType,
  cap.previous_deviceModel AS prevDeviceModel,
  cap.time_diff_seconds,
  com.comment_count
FROM
  RecentComments AS com
INNER JOIN
  RecentCaptions AS cap
ON
  com.s_streamID = CAST(cap.problematic_streamID AS STRING)
ORDER BY
  com.s_streamID ASC