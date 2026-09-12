DECLARE startTime TIMESTAMP DEFAULT TIMESTAMP_SUB(
  TIMESTAMP_SECONDS({{ $json.beginTime }}),
  INTERVAL 5 MINUTE
);
DECLARE endTime TIMESTAMP DEFAULT TIMESTAMP_ADD(
  TIMESTAMP_SECONDS({{ $json.endTime }}),
  INTERVAL 5 MINUTE
);
DECLARE target_error_type ARRAY<STRING> DEFAULT ["ANR", "FATAL"];

SELECT
  error_type,
  issue_id,
  issue_title,
  issue_subtitle,
  event_timestamp,
  device,
  memory,
  storage,
  operating_system,
  application,
  user,
  custom_keys,
  process_state
FROM `media-b6ace.firebase_crashlytics.com_machipopo_media17_ANDROID_REALTIME`
WHERE event_timestamp BETWEEN startTime AND endTime
  AND user.id = "{{ $json.userID }}"
  AND error_type IN UNNEST(target_error_type)
ORDER BY event_timestamp ASC;