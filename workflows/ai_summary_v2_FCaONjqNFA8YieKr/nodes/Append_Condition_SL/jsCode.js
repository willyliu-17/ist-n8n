// ====================================================
// 1. 定義檢查條件 (靜態配置)
// ====================================================
const CHECK_CONDITIONS = [
   { id: 'push report', description: 'pushReport exists', field: 'Type', operator: '==', value: "PushReport", ignoreNA: true, outputs: [] },
  { id: 'bitrate_zero', description: 'Bitrate CV = 0', field: 'BitrateCV', operator: '==', value: 0, ignoreNA: false, outputs: 				['BitrateCV','BitrateMin','PingMax','PingMedian','UnsentCountMax','UserIP','IPRegion','NetworkType','Width','Height'] },
    { id: 'bitrate_fail', description: 'Bitrate CV > 0.3', field: 'BitrateCV', operator: '>', value: 0.3, ignoreNA: false, outputs: ['BitrateCV','BitrateMin','PingMax','PingMedian','UnsentCountMax','UserIP','IPRegion','NetworkType','Width','Height'] },
    { id: 'ping_fail', description: 'Ping Max > 350', field: 'PingMax', operator: '>', value: 350, ignoreNA: false, outputs: ['BitrateCV','BitrateMin','PingMax','PingMedian','UnsentCountMax','UserIP','IPRegion','NetworkType','Width','Height'] },
    { id: 'unsent_count', description: 'UnsentCountMax > 43', field: 'UnsentCountMax', operator: '>', value: 43, ignoreNA: false, outputs: ['BitrateCV','BitrateMin','PingMax','PingMedian','UnsentCountMax','UserIP','IPRegion','NetworkType','Width','Height'] },
];

// ====================================================
// 2. 獲取 Stream 資訊 (從第一個項目獲取即可)
// ====================================================
// $input.all() 會取得所有從上游傳入的資料
const allItems = $input.all();

// 如果沒有資料，直接回傳空
if (allItems.length === 0) return [];

// 取得 streamID (抓第一個 item 即可，假設同一批次都是同一個 ID)
const firstItem = allItems[0].json;
const streamInfo = $node["query stream info"].json;
const streamID = streamInfo.liveStreamID || streamInfo.LiveStreamID || "Unknown";

// ====================================================
// 3. 彙整所有 Log 並輸出單一物件
// ====================================================
// 將所有項目的 json 內容提取出來放入 array
const combinedLogs = allItems.map(item => item.json);

return {
    liveStreamID: streamID,
    type: "streamerLog",
    conditions: CHECK_CONDITIONS,
    log: combinedLogs // 這裡會是 [ {row1}, {row2}, ... ]
};