// Node A: 彙整配置 (硬編碼) 和 Log 數據 (從輸入流 'items' 獲取)

// ====================================================
// 🔧 1. 靜態配置 (CHECK_CONDITIONS)
// ====================================================


const CHECK_CONDITIONS = [
    {
        id: 'bitrate_fail',
        description: 'Bitrate CV < 0.3',
        field: 'BitrateCV',
        operator: '>',
        value: 0.3,
        ignoreNA: false, 
    },
    {
        id: 'ping_fail',
        description: 'Ping Max < 350',
        field: 'PingMax',
        operator: '>',
        value: 350,
        ignoreNA: false, 
    }, {
        id: 'unsent_count',
        description: 'UnsentCountMax < 43',
        field: 'UnsentCountMax',
        operator: '>',
        value: 43,
        ignoreNA: false, 
    },
];

// ====================================================
// 🔧 2. 獲取所有輸入 Items (Log 數據)
// ====================================================

const allInputItems = items; // 獲取上一個節點傳入的所有 Item 容器

// 提取所有 Item 內部的純 JSON 數據
const logDataArray = allInputItems.map(item => item.json);


// ====================================================
// 3. 彙整並輸出單一 Item 給 Node B
// ====================================================

// 返回一個 Item，其中包含兩個鍵：conditions 和 log
return [{
    json: {
        conditions: CHECK_CONDITIONS, // 靜態配置陣列
        log: logDataArray             // Log 數據陣列
    }
}];