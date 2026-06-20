DECLARE timeRegion STRING DEFAULT 'Asia/Taipei';
DECLARE searchKeywords STRING DEFAULT r'{{ $json.searchKeywords || "卡了|重開|當機" }}';
-- [Real Case]
DECLARE queryEndDate TIMESTAMP DEFAULT TIMESTAMP_TRUNC(
  {{
    (() => {
      try {
        // Try to get manually input
        const manualTime = $('Manually trigger').first().json.timestamp;
        
        if (manualTime) {
          return `TIMESTAMP("${manualTime}")`; 
        }
      } catch (e) {
        // Ignore error
      }
      // Others, use current timestamp
      return 'CURRENT_TIMESTAMP()';
    })()
  }},
  DAY, "Asia/Taipei"
) + INTERVAL 4 HOUR;
DECLARE queryStartDate TIMESTAMP DEFAULT queryEndDate - INTERVAL {{
    (() => {
      try {
        const manualInterval = $json.manualInterval;
        
        if (manualInterval && !isNaN(manualInterval)) {
          return parseInt(manualInterval); 
        }
      } catch (e) {
        // Ignore error
      }
      return 1;
    })()
}} DAY;
WITH
  -- Get RecentComments
  RecentStreamIDs AS ( 
    SELECT
      DISTINCT CAST(liveStreamID AS STRING) AS liveStreamID
    FROM
      `media17-1119.mongodb.LiveStreamV2`
    WHERE 
      TIMESTAMP_SECONDS(beginTime) BETWEEN queryStartDate AND queryEndDate
      AND beginTime IS NOT NULL
      AND liveStreamID IS NOT NULL 
  ),
  RecentComments AS (
    SELECT
      s_streamID,
    FROM
      `media17-1119.eventStreaming.streamComment`
    WHERE
      _PARTITIONTIME BETWEEN queryStartDate AND queryEndDate
      AND s_streamID IN (SELECT liveStreamID FROM RecentStreamIDs)
      AND REGEXP_CONTAINS(s_content, searchKeywords)
    GROUP BY s_streamID
    ORDER BY s_streamID ASC
  ),
  -- Get RecentCaptions
  AllStreamsRanked AS ( 
    SELECT
      userID,
      liveStreamID,
      beginTime,
      endTime,
      closeBy, 
      caption,
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
      ) AS previous_liveStreamID
    FROM
      `media17-1119.mongodb.LiveStreamV2`
    WHERE 
      beginTime IS NOT NULL
      AND endTime IS NOT NULL
      AND userID IS NOT NULL
  ),
  RecentCaptions AS (
    SELECT
      userID,
      liveStreamID AS problematic_streamID,
      DATETIME(TIMESTAMP_SECONDS(beginTime), 'Asia/Taipei') AS problematic_stream_BeginTime_Taipei,
      caption AS problematic_stream_caption,
      closeBy AS problematic_stream_closeBy,
      previous_liveStreamID,
      previous_closeBy,
      (beginTime - previous_endTime) AS time_diff_seconds,
      DATETIME(TIMESTAMP_SECONDS(previous_endTime), 'Asia/Taipei') AS previous_stream_EndTime_Taipei
    FROM
      AllStreamsRanked
    WHERE
      TIMESTAMP_SECONDS(beginTime) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
      AND REGEXP_CONTAINS(caption, r"卡了|重開|當機")
      AND previous_endTime IS NOT NULL
    ORDER BY
      userID,
      beginTime DESC
  )
-- Get Join ----------------------
SELECT
  com.s_streamID AS streamID,
  cap.problematic_stream_caption AS caption,
  cap.previous_liveStreamID AS prevStreamID,
  cap.previous_closeBy AS prevCloseBy,
  cap.time_diff_seconds,
FROM
  RecentComments AS com
INNER JOIN
  RecentCaptions AS cap
ON
  com.s_streamID = CAST(cap.problematic_streamID AS STRING)
WHERE
  cap.time_diff_seconds < 3600
ORDER BY
  cap.previous_closeBy,
  com.s_streamID