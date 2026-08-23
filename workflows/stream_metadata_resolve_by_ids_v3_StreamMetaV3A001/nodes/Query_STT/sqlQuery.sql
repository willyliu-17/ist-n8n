=SELECT
  liveStreamID,
  userID,
  beginTime,
  endTime,
  duration,
  caption,
  region,
  vliverModel,
  deviceInfo.version AS appVersion,
  deviceInfo.type AS deviceType,
  closeBy,
  streamMode,
  deviceInfo.deviceModel AS deviceModel,
  deviceInfo.OSVersion AS osVersion,
  deviceInfo.publicIP AS publicIP,
  deviceInfo.ipRegion AS ipRegion,
  CASE
    WHEN STRPOS(caption, ' 正在開播') > 1
      THEN NULLIF(TRIM(SPLIT(caption, ' 正在開播')[SAFE_OFFSET(0)]), '')
    ELSE NULL
  END AS openID
FROM `media17-1119.mongodb.LiveStreamV2`
WHERE liveStreamID IN UNNEST({{ $('Validate and Normalize').first().json.idsSqlLiteral }})
  AND beginTime >= UNIX_SECONDS(TIMESTAMP(@window_start))
  AND beginTime < UNIX_SECONDS(TIMESTAMP(@window_end))
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY liveStreamID
  ORDER BY
    beginTime DESC,
    endTime DESC,
    userID DESC,
    TO_JSON_STRING(STRUCT(
      liveStreamID AS liveStreamID,
      userID AS userID,
      beginTime AS beginTime,
      endTime AS endTime,
      duration AS duration,
      caption AS caption,
      region AS region,
      vliverModel AS vliverModel,
      deviceInfo.version AS appVersion,
      deviceInfo.type AS deviceType,
      closeBy AS closeBy,
      streamMode AS streamMode,
      deviceInfo.deviceModel AS deviceModel,
      deviceInfo.OSVersion AS osVersion,
      deviceInfo.publicIP AS publicIP,
      deviceInfo.ipRegion AS ipRegion,
      CASE
        WHEN STRPOS(caption, ' 正在開播') > 1
          THEN NULLIF(TRIM(SPLIT(caption, ' 正在開播')[SAFE_OFFSET(0)]), '')
        ELSE NULL
      END AS openID
    )) DESC
) = 1
