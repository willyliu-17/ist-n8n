=SELECT
  liveStreamID,
  userID,
  beginTime,
  endTime,
  publishSec,
  region,
  deviceInfo.ipRegion AS ipRegion
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
      publishSec AS publishSec,
      region AS region,
      deviceInfo.ipRegion AS ipRegion
    )) DESC
) = 1
