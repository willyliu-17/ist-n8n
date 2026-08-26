=SELECT
  liveStreamID,
  streamerID AS userID,
  streamer.openID AS openID,
  UNIX_SECONDS(beginTime) AS beginTime,
  UNIX_SECONDS(endTime) AS endTime,
  liveStreamDuration AS duration,
  stream.closeBy AS closeBy,
  stream.streamMode AS streamMode,
  stream.vliverModel AS vliverModel,
  stream.isOBS AS isOBS
FROM `media17-1119.MatomoDataMart.LiveStreamWithViewerInfo`
WHERE liveStreamID IN UNNEST({{ $('Validate and Normalize').first().json.stringIdsSqlLiteral }})
  AND beginTime >= TIMESTAMP(@window_start)
  AND beginTime < TIMESTAMP(@window_end)
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY liveStreamID
  ORDER BY
    beginTime DESC,
    endTime DESC,
    streamerID DESC,
    TO_JSON_STRING(STRUCT(
      liveStreamID AS liveStreamID,
      streamerID AS userID,
      streamer.openID AS openID,
      UNIX_SECONDS(beginTime) AS beginTime,
      UNIX_SECONDS(endTime) AS endTime,
      liveStreamDuration AS duration,
      stream.closeBy AS closeBy,
      stream.streamMode AS streamMode,
      stream.vliverModel AS vliverModel,
      stream.isOBS AS isOBS
    )) DESC
) = 1
