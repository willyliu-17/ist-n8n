DECLARE startTime TIMESTAMP DEFAULT TIMESTAMP_SUB(TIMESTAMP_SECONDS({{ $json.beginTime }}), INTERVAL 5 MINUTE);
DECLARE endTime TIMESTAMP DEFAULT TIMESTAMP_ADD(TIMESTAMP_SECONDS({{ $json.endTime }}), INTERVAL 5 MINUTE);

SELECT 
-- DATETIME(timestamp_utc, 'Asia/Taipei') AS UTCp8,
DATETIME(timestamp_millis_utc, 'Asia/Taipei') AS UTCp8_ms,
session_id,
advertising_id,
url_name,
url_site,
url_source,
url_page,
action_type,
event_action,
event_category,
event_name,
event_value,
content_id,
content_type,
product_id,
receive_user_id,
search,
comment,
purchase_amount,
currency,
send_point,
receive_point,
generic_json,
generic_text,
trace_id,
trade_id,
clientEventKey,
component_id,
component_type,
idaction_name,
idaction_url,
idaction_event_action,
idaction_event_category,
idaction_url_ref,
idaction_name_ref,
created_at,
link_id,
updateVersion,
specType,
pageKey,
keyword,
host,
businessGroup,
FROM `media17-1119.MatomoCore.base_visit_action`
WHERE timestamp_utc BETWEEN startTime AND endTime
AND url_site = "{{
  $json.type === 'ANDROID'
    ? 'com.machipopo.media17'
    : 'com.machipopo.story17'
}}"
AND user_id = "{{ $json.userID }}"
order by timestamp_millis_utc ASC