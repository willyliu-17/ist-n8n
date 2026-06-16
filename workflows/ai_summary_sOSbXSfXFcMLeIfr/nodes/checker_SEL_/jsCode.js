// ====================================================
// 1. 取得資料與條件
// ====================================================
const inputItem = $json;
const liveStreamID = inputItem.liveStreamID || "N/A";
const type = inputItem.type || "N/A";
const originalConditions = inputItem.conditions || [];
const logs = inputItem.log || [];
let allFilteredLogs = [];

// ====================================================
// 🔧 輔助函數：執行檢查邏輯 (維持不變)
// ====================================================
function executeCheck(rowData, condition) {
    let met = false;
    let actualValue = null;
    let timestamp = rowData.ClientTimeUTCp8 || rowData.UTCp8; 
    let isNA = false;
    let isStringCheck = false;

    try {
        const rawValue = rowData[condition.field];
        if (rawValue === null || rawValue === undefined) {
            isNA = true;
        } else if (condition.operator === '==' || condition.operator === '!=') {
            isStringCheck = true;
            actualValue = rawValue;
        } else {
            actualValue = parseFloat(rawValue);
            if (isNaN(actualValue)) isNA = true;
        }

        if (!isNA) {
            if (isStringCheck) {
                const targetValue = String(condition.value);
                const compareValue = String(actualValue);
                met = (condition.operator === '==') ? (compareValue === targetValue) : (compareValue !== targetValue);
            } else {
                const targetNum = parseFloat(condition.value);
                switch (condition.operator) {
                    case '<': met = actualValue < targetNum; break;
                    case '>': met = actualValue > targetNum; break;
                    case '==': met = actualValue === targetNum; break;
                    case '!=': met = actualValue !== targetNum; break;
                    default: met = false;
                }
            }
        } else if (condition.ignoreNA === false) {
            met = true; 
        }
    } catch (e) {}
    
    return { met, actualValue, timestamp, isNA };
}

// ====================================================
// 🔧 主邏輯 (AND 邏輯：使用 .every())
// ====================================================
if (Array.isArray(originalConditions) && Array.isArray(logs)) {
    logs.forEach((rowData, index) => {
        // 必須「每一項」條件都回傳 true (即：不等於 Normal Ping 且 不等於 Normal CDN...)
        const allConditionsMet = originalConditions.every(condition => {
            return executeCheck(rowData, condition).met;
        });

        if (allConditionsMet) {
            let snippetObj = {};
            let firstTimestamp = 'N/A';

            // 收集所有相關欄位資訊
            originalConditions.forEach(condition => {
                const { actualValue, timestamp, isNA } = executeCheck(rowData, condition);
                snippetObj[condition.field] = isNA ? 'N/A' : actualValue;
                if (firstTimestamp === 'N/A') firstTimestamp = timestamp;
                
                if (condition.outputs) {
                    condition.outputs.forEach(outField => {
                        snippetObj[outField] = (rowData[outField] === undefined) ? 'N/A' : rowData[outField];
                    });
                }
            });

            allFilteredLogs.push({
                conditionID: "COMBINED_CHECK",
                description: "Matched all exclusion criteria",
                lineNumber: index + 1,
                timestamp: firstTimestamp,
                dataSnippet: snippetObj
            });
        }
    });
}

// 排序 (由舊到新)
allFilteredLogs.sort((a, b) => {
    if (a.timestamp === 'N/A') return 1;
    if (b.timestamp === 'N/A') return -1;
    return new Date(a.timestamp) - new Date(b.timestamp);
});

return {
    liveStreamID,
    type,
    conditions: originalConditions,
    filterLogs: allFilteredLogs
};