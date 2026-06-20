DECLARE input_start_unix INT64 DEFAULT {{ $json.beginTime }}; -- 2025-11-18 14:00:00 UTC
DECLARE input_end_unix INT64 DEFAULT {{ $json.endTime }};   -- 2025-11-18 14:59:59 UTC

DECLARE start_time TIMESTAMP DEFAULT TIMESTAMP_SECONDS(input_start_unix);
DECLARE end_time TIMESTAMP DEFAULT TIMESTAMP_SECONDS(input_end_unix);

-- 設定「中斷」的閾值，例如 15 秒
DECLARE max_interval_seconds INT64 DEFAULT 15; 

WITH
  alive_logs AS (
    -- 1. 選取符合條件的日誌，並依照時間排序
    SELECT 
      timestamp,
      requestPath,
      requestMethod
    FROM 
      `media17-prod.backendAPILogs.RESTResponseLogs` 
    WHERE 
      REGEXP_CONTAINS(requestPath, r'/api/v1/lives/[0-9]+/alive')
      AND requestMethod = 'POST'
      AND timestamp >= start_time
      AND timestamp <= end_time
      AND userID = "{{ $json.userID }}"
    ORDER BY
      timestamp ASC -- 確保日誌是按時間順序處理
  ),
  
  -- 2. 使用 LAG() 函數計算時間間隔
  interval_calculation AS (
    SELECT
      *,
      -- 取得上一筆請求的時間戳
      LAG(timestamp, 1) OVER (ORDER BY timestamp) AS previous_timestamp,
      
      -- 計算當前請求與上一筆請求之間的時間差 (單位：秒)
      TIMESTAMP_DIFF(timestamp, LAG(timestamp, 1) OVER (ORDER BY timestamp), SECOND) AS time_diff_seconds
    FROM
      alive_logs
  )

-- 3. 找出時間間隔大於閾值的中斷點
SELECT 
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M:%S', timestamp, 'Asia/Taipei') AS gap_end_time_cst,
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M:%S', previous_timestamp, 'Asia/Taipei') AS UTCp8,
  time_diff_seconds
FROM 
  interval_calculation
WHERE 
  time_diff_seconds > max_interval_seconds -- 找出超過 15 秒間隔的記錄
ORDER BY
  timestamp ASC
