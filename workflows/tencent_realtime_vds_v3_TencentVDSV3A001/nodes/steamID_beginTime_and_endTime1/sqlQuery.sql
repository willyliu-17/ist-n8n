-- 設定搜尋範圍為最近 30 天
DECLARE limit_timestamp TIMESTAMP DEFAULT TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY);

SELECT 
  userID,
  DATETIME(TIMESTAMP_SECONDS(beginTime), 'Asia/Taipei') as BeginTimeU8,
  beginTime, endTime, publishSec, duration, closeBy,
  landscape, liveStreamID, streamType, streamMode, streamerType, 
  caption,
  premiumContent.premiumType,
  archiveConfig,
  deviceInfo.deviceName, deviceInfo.deviceModel,
  deviceInfo.type, deviceInfo.version, deviceInfo.hardware, deviceInfo.OSVersion, 
  deviceInfo.Customization, deviceInfo.publicIP, deviceInfo.ipRegion,
  premiumContent, *
FROM `media17-1119.mongodb.LiveStreamV2`
WHERE 
  -- 篩選特定的 Stream ID
  liveStreamID = {{ $json.streamID }}
  AND TIMESTAMP_SECONDS(beginTime) >= limit_timestamp
  
  AND beginTime is NOT NULL
  AND endTime is NOT NULL