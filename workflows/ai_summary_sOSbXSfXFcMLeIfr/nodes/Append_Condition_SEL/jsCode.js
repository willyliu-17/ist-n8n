// 適用於單次執行 (Per-item)
const CHECK_CONDITIONS = [
    {
        id: 'Normal Ping',
        description: 'except Normal Ping',
        field: 'title',
        operator: '!=',
        value: "Normal Ping",
        ignoreNA: true, 
        outputs: ['Log'],
    },
    {
        id: 'Poor CDN Connection',
        description: 'except Poor CDN Connection',
        field: 'title',
        operator: '!=',
        value: "Poor CDN Connection",
        ignoreNA: true, 
        outputs: ['Log'],
    },
    {
        id: 'Normal CDN Connection',
        description: 'except Normal CDN Connection',
        field: 'title',
        operator: '!=',
        value: "Normal CDN Connection",
        ignoreNA: true, 
        outputs: ['Log'],
    },
    {
        id: 'Slow Ping',
        description: 'except Slow Ping',
        field: 'title',
        operator: '!=',
        value: "Slow Ping",
        ignoreNA: true, 
        outputs: ['Log'],
    },
    {
        id: 'Normal CPU Info',
        description: 'except Normal CPU Info',
        field: 'title',
        operator: '!=',
        value: "Normal CPU Info",
        ignoreNA: true, 
        outputs: ['Log'],
    },
    {
        id: 'streamer_event_report',
        description: 'except streamer_event_report',
        field: 'Type',
        operator: '!=',
        value: "streamer_event_report",
        ignoreNA: true, 
        outputs: ['Log'],
    },
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
    type: "streamEventLog",
    conditions: CHECK_CONDITIONS,
    log: combinedLogs // 這裡會是 [ {row1}, {row2}, ... ]
};