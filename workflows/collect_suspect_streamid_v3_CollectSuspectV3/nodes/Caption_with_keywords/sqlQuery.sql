DECLARE queryEndDate TIMESTAMP DEFAULT TIMESTAMP(@query_end);
DECLARE queryStartDate TIMESTAMP DEFAULT TIMESTAMP_SUB(queryEndDate, INTERVAL 2 DAY);
DECLARE predecessorStartDate TIMESTAMP DEFAULT TIMESTAMP_SUB(queryStartDate, INTERVAL 10 DAY);
DECLARE searchKeywords STRING DEFAULT @search_keywords;

WITH RankedStreams AS (
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
    LAG(endTime) OVER (PARTITION BY userID ORDER BY beginTime) AS previous_endTime,
    LAG(closeBy) OVER (PARTITION BY userID ORDER BY beginTime) AS previous_closeBy,
    LAG(liveStreamID) OVER (PARTITION BY userID ORDER BY beginTime) AS previous_liveStreamID
  FROM `media17-1119.mongodb.LiveStreamV2`
  WHERE TIMESTAMP_SECONDS(beginTime) >= predecessorStartDate
    AND TIMESTAMP_SECONDS(beginTime) < queryEndDate
    AND beginTime IS NOT NULL
    AND endTime IS NOT NULL
    AND userID IS NOT NULL
),
CandidateStreams AS (
  SELECT *
  FROM RankedStreams
  WHERE TIMESTAMP_SECONDS(beginTime) >= queryStartDate
    AND TIMESTAMP_SECONDS(beginTime) < queryEndDate
)
SELECT
  userID,
  CAST(liveStreamID AS STRING) AS streamID,
  previous_liveStreamID AS prevStreamID,
  previous_closeBy AS prevCloseBy,
  caption,
  closeBy,
  publishSec,
  deviceType,
  deviceModel,
  beginTime - previous_endTime AS time_diff_seconds
FROM CandidateStreams
WHERE REGEXP_CONTAINS(caption, searchKeywords)
  AND previous_endTime IS NOT NULL
  AND beginTime - previous_endTime < 3600
ORDER BY streamID;
