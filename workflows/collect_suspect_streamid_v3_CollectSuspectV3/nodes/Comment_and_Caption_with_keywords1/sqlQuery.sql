DECLARE queryEndDate TIMESTAMP DEFAULT TIMESTAMP(@query_end);
DECLARE queryStartDate TIMESTAMP DEFAULT TIMESTAMP_SUB(queryEndDate, INTERVAL 2 DAY);
DECLARE predecessorStartDate TIMESTAMP DEFAULT TIMESTAMP_SUB(queryStartDate, INTERVAL 10 DAY);
DECLARE searchKeywords STRING DEFAULT @search_keywords;

WITH RecentComments AS (
  SELECT DISTINCT s_streamID
  FROM `media17-1119.eventStreaming.streamComment`
  WHERE _PARTITIONTIME >= queryStartDate
    AND _PARTITIONTIME < queryEndDate
    AND REGEXP_CONTAINS(s_content, searchKeywords)
),
RankedStreams AS (
  SELECT
    userID,
    liveStreamID,
    beginTime,
    endTime,
    caption,
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
  candidate.userID,
  CAST(candidate.liveStreamID AS STRING) AS streamID,
  candidate.previous_liveStreamID AS prevStreamID,
  candidate.previous_closeBy AS prevCloseBy,
  candidate.caption,
  candidate.beginTime - candidate.previous_endTime AS time_diff_seconds
FROM CandidateStreams AS candidate
INNER JOIN RecentComments AS comments
  ON comments.s_streamID = CAST(candidate.liveStreamID AS STRING)
WHERE REGEXP_CONTAINS(candidate.caption, searchKeywords)
  AND candidate.previous_endTime IS NOT NULL
  AND candidate.beginTime - candidate.previous_endTime < 3600
ORDER BY streamID;
