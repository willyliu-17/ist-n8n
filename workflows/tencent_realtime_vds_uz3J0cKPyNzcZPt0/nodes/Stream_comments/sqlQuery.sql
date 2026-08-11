DECLARE timeRegion STRING DEFAULT 'Asia/Taipei';

-- 1. 定義原本的基礎時間（減加 5 分鐘主要用於分割區包容誤差）
DECLARE startTime TIMESTAMP DEFAULT TIMESTAMP_SUB(TIMESTAMP_SECONDS({{ $('steamID beginTime and endTime1').item.json.beginTime }}), INTERVAL 5 MINUTE);
DECLARE endTime TIMESTAMP DEFAULT TIMESTAMP_ADD(TIMESTAMP_SECONDS({{ $('steamID beginTime and endTime1').item.json.endTime }} ), INTERVAL 5 MINUTE);

-- 2. 新增：計算精準的截取片段時間點
DECLARE clipStartTime TIMESTAMP DEFAULT TIMESTAMP_ADD(TIMESTAMP_SECONDS({{ $('steamID beginTime and endTime1').item.json.beginTime }}), INTERVAL {{ $('Start').item.json.startSec }} SECOND);

-- 這裡加入了你的需求：durationSec = 0 時自動帶入完整的 endTime
DECLARE clipEndTime TIMESTAMP DEFAULT (
  CASE 
    WHEN {{ $('Start').item.json.durationSec }} = 0 
    THEN TIMESTAMP_SECONDS({{ $('steamID beginTime and endTime1').item.json.endTime }})
    ELSE TIMESTAMP_ADD(clipStartTime, INTERVAL {{ $('Start').item.json.durationSec }} SECOND)
  END
);

SELECT
  s_streamID, -- Do NOT remove it for output check
  DATETIME(insertTs, "Asia/Taipei") as UTCp8, msg, s_content, s_region, s_reqOpenID, s_reqUserID
FROM
  `media17-1119.eventStreaming.streamComment`
WHERE
  -- 保留分割區篩選（維持效能，避免全表掃描）
  _PARTITIONTIME BETWEEN TIMESTAMP_TRUNC(startTime, DAY) AND TIMESTAMP_TRUNC(endTime, DAY)
  
  -- 將原本的 insertTs 範圍，縮小到你指定的精準截取區間
  AND insertTs BETWEEN clipStartTime AND clipEndTime
  
  AND s_streamID = "{{ $('Start').item.json.streamID }}" 
ORDER by s_streamID, UTCp8 ASC;