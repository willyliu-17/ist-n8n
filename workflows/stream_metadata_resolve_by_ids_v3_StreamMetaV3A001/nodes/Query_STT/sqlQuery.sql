=WITH identity AS (
  SELECT
    liveStreamID,
    streamerID AS userID,
    NULLIF(TRIM(streamer.openID), '') AS openID
  FROM `media17-1119.MatomoDataMart.LiveStreamWithViewerInfo`
  WHERE liveStreamID IN UNNEST({{ $('Validate and Normalize').first().json.stringIdsSqlLiteral }})
    AND beginTime >= TIMESTAMP(@window_start)
    AND beginTime < TIMESTAMP(@window_end)
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY liveStreamID
    ORDER BY beginTime DESC, endTime DESC, streamerID DESC, streamer.openID DESC
  ) = 1
)
SELECT
  stream.liveStreamID,
  stream.userID,
  stream.beginTime,
  stream.endTime,
  stream.duration,
  stream.region,
  stream.vliverModel,
  stream.deviceInfo.version AS appVersion,
  stream.deviceInfo.type AS deviceType,
  identity.openID
FROM `media17-1119.mongodb.LiveStreamV2` AS stream
LEFT JOIN identity
  ON identity.liveStreamID = CAST(stream.liveStreamID AS STRING)
  AND identity.userID = stream.userID
WHERE stream.liveStreamID IN UNNEST({{ $('Validate and Normalize').first().json.int64IdsSqlLiteral }})
  AND stream.beginTime >= UNIX_SECONDS(TIMESTAMP(@window_start))
  AND stream.beginTime < UNIX_SECONDS(TIMESTAMP(@window_end))
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY stream.liveStreamID
  ORDER BY
    stream.beginTime DESC,
    stream.endTime DESC,
    stream.userID DESC,
    TO_JSON_STRING(STRUCT(
      stream.liveStreamID AS liveStreamID,
      stream.userID AS userID,
      stream.beginTime AS beginTime,
      stream.endTime AS endTime,
      stream.duration AS duration,
      stream.region AS region,
      stream.vliverModel AS vliverModel,
      stream.deviceInfo.version AS appVersion,
      stream.deviceInfo.type AS deviceType,
      identity.openID AS openID
    )) DESC
) = 1
