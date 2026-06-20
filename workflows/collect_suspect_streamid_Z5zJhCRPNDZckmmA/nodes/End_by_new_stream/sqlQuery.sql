DECLARE timeRegion STRING DEFAULT 'Asia/Taipei';

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
  -- Get RecentComments
  RecentStreamIDs AS ( 
    SELECT
      liveStreamID,
      userID,
      beginTime,
      endTime,
      closeBy,
      caption,

      -- 取得上一場的 endTime
      LAG(endTime, 1) OVER ( 
        PARTITION BY userID 
        ORDER BY beginTime ASC
      ) AS previous_endTime,
      -- 取得上一場的 closeBy
      LAG(closeBy, 1) OVER ( 
        PARTITION BY userID 
        ORDER BY beginTime ASC
      ) AS previous_closeBy,
      -- 取得上一場的 liveStreamID (方便核對)
      LAG(liveStreamID, 1) OVER ( 
        PARTITION BY userID 
        ORDER BY beginTime ASC
      ) AS previous_liveStreamID,

      deviceInfo.ipRegion,
      region,
      device
    FROM
      `media17-1119.mongodb.LiveStreamV2`
    WHERE -- 使用 beginTime (轉換為 TIMESTAMP) 來篩選時間範圍
      TIMESTAMP_SECONDS(beginTime) BETWEEN queryStartDate AND queryEndDate
      AND deviceInfo.ipRegion = "TW"
      AND region = "TW"
      AND device NOT IN ("OBS")
      AND beginTime IS NOT NULL
      AND endTime IS NOT NULL
      AND liveStreamID IS NOT NULL -- 順便確保 liveStreamID 不是 NULL
  ),
  -- Find all userIDs with a contract in the specified month (JP region, not deleted, not terminated)
  ContractedUsers AS (
    SELECT
      DISTINCT userID
    FROM `media17-1119.mysql17admin.Contract`
    WHERE
      dateStart < queryStartDate
      AND dateEnd >= queryEndDate
      AND isDeleted = 0
      AND isTerminated = 0
)

-- Get Join ----------------------
SELECT
  rec.liveStreamID AS streamID,
  rec.userID,
  DATETIME(TIMESTAMP_SECONDS(rec.beginTime), "Asia/Taipei") AS beginTime_Utc8,
  DATETIME(TIMESTAMP_SECONDS(rec.endTime), "Asia/Taipei") AS endTime_Utc8,
  rec.closeBy,
  rec.caption,

  DATETIME(TIMESTAMP_SECONDS(rec.previous_endTime), "Asia/Taipei") AS prevEndTime_Utc8,
  rec.previous_closeBy,
  rec.previous_liveStreamID AS prevStreamID,

  rec.ipRegion,
  rec.region,
  rec.device
FROM
  RecentStreamIDs AS rec
INNER JOIN
  ContractedUsers AS cont
ON
  cont.userID = rec.userID
WHERE
  (rec.beginTime - rec.previous_endTime) < 60
  AND rec.previous_closeBy = "end by new stream"
ORDER BY
  rec.beginTime ASC,
  rec.userID ASC,
  rec.liveStreamID ASC
  