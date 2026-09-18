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
FROM `{{
  (() => {
    const platform = String($json.type ?? '').toUpperCase();

    if (platform === 'ANDROID') {
      return 'media-b6ace.firebase_crashlytics.com_machipopo_media17_ANDROID_REALTIME';
    }

    if (platform === 'IOS') {
      return 'media17-prod.firebase_crashlytics.com_machipopo_story17_IOS_REALTIME';
    }

    throw new Error(`Unsupported platform: ${$json.type}`);
  })()
}}`
WHERE event_timestamp BETWEEN startTime AND endTime
  AND user.id = "{{ $json.userID }}"
  AND error_type IN UNNEST(target_error_type)
ORDER BY event_timestamp ASC;