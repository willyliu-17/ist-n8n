DECLARE queryEndDate TIMESTAMP DEFAULT TIMESTAMP(@query_end);
DECLARE queryStartDate TIMESTAMP DEFAULT TIMESTAMP_SUB(queryEndDate, INTERVAL 1 DAY);
DECLARE predecessorStartDate TIMESTAMP DEFAULT TIMESTAMP_SUB(queryStartDate, INTERVAL 10 DAY);

WITH RankedStreams AS (
  SELECT
    liveStreamID,
    userID,
    beginTime,
    endTime,
    closeBy,
    caption,
    deviceInfo.ipRegion AS ipRegion,
    region,
    device,
    LAG(endTime) OVER (PARTITION BY userID ORDER BY beginTime) AS previous_endTime,
    LAG(closeBy) OVER (PARTITION BY userID ORDER BY beginTime) AS previous_closeBy,
    LAG(liveStreamID) OVER (PARTITION BY userID ORDER BY beginTime) AS previous_liveStreamID
  FROM `media17-1119.mongodb.LiveStreamV2`
  WHERE TIMESTAMP_SECONDS(beginTime) >= predecessorStartDate
    AND TIMESTAMP_SECONDS(beginTime) < queryEndDate
    AND beginTime IS NOT NULL
    AND endTime IS NOT NULL
    AND liveStreamID IS NOT NULL
    AND deviceInfo.ipRegion = 'TW'
    AND region = 'TW'
    AND device != 'OBS'
),
CandidateStreams AS (
  SELECT *
  FROM RankedStreams
  WHERE TIMESTAMP_SECONDS(beginTime) >= queryStartDate
    AND TIMESTAMP_SECONDS(beginTime) < queryEndDate
),
ContractedUsers AS (
  SELECT DISTINCT userID
  FROM `media17-1119.mysql17admin.Contract`
  WHERE dateStart < queryStartDate
    AND dateEnd >= queryEndDate
    AND isDeleted = 0
    AND isTerminated = 0
)
SELECT
  CAST(candidate.liveStreamID AS STRING) AS streamID,
  candidate.userID,
  candidate.previous_liveStreamID AS prevStreamID,
  candidate.previous_closeBy AS prevCloseBy,
  candidate.caption,
  candidate.ipRegion,
  candidate.region,
  candidate.device
FROM CandidateStreams AS candidate
INNER JOIN ContractedUsers AS contracted USING (userID)
WHERE candidate.previous_endTime IS NOT NULL
  AND candidate.beginTime - candidate.previous_endTime < 60
  AND candidate.previous_closeBy = 'end by new stream'
ORDER BY candidate.beginTime, candidate.userID, candidate.liveStreamID;
