// 設置 Code 節點為: Run once for all items (所有項目運行一次)

// ====================================================
// 🔧 輔助函數 1: 條件檢查執行器 (修正版)
// ====================================================

function executeCheck(rowData, condition) {
    let met = false;
    let actualValue = null;
    let timestamp = rowData.ClientTimeUTCp8 || rowData.UTCp8; 
    let isNA = false;
    let isStringCheck = false;

    try {
        const rawValue = rowData[condition.field];
        let valueToCompare;

        // 1. 處理 null 或 undefined
        if (rawValue === null || rawValue === undefined) {
            isNA = true;
        } 
        // 2. 優先處理字串比較 (針對標題、狀態等文字)
        // 只要操作符是 == 或 !=，我們優先視為字串比對，避免被數字轉型干擾
        else if (condition.operator === '==' || condition.operator === '!=') {
            isStringCheck = true;
            actualValue = rawValue;
            valueToCompare = String(rawValue); // 確保轉為字串進行比較
        }
        // 3. 處理布林值
        else if (typeof rawValue === 'boolean') {
            valueToCompare = rawValue ? 1 : 0;
            actualValue = valueToCompare;
        } 
        // 4. 處理數字和數字字串 (用於 > < <= >=)
        else if (typeof rawValue === 'number' || (typeof rawValue === 'string' && rawValue.trim() !== '')) {
            valueToCompare = parseFloat(rawValue);
            if (!isNaN(valueToCompare)) {
                actualValue = valueToCompare;
            } else {
                isNA = true;
            }
        } 
        else {
            isNA = true;
        }

        // --- 執行檢查邏輯 ---
        if (!isNA) {
            if (isStringCheck) {
                // 文字比較
                const targetValue = String(condition.value);
                if (condition.operator === '==') met = (valueToCompare === targetValue);
                if (condition.operator === '!=') met = (valueToCompare !== targetValue);
            } else {
                // 數字比較
                const targetNum = parseFloat(condition.value);
                switch (condition.operator) {
                    case '<': met = valueToCompare < targetNum; break;
                    case '>': met = valueToCompare > targetNum; break;
                    case '<=': met = valueToCompare <= targetNum; break;
                    case '>=': met = valueToCompare >= targetNum; break;
                    case '==': met = valueToCompare === targetNum; break;
                    case '!=': met = valueToCompare !== targetNum; break;
                    default: met = false;
                }
            }
        } else {
            // N/A 處理：如果要求不忽略 N/A，則標記為 Failed (met = true)
            if (condition.ignoreNA === false) {
                met = true; 
            }
        }
    } catch (e) {
        // 忽略單行錯誤
    }

    return { met, actualValue, timestamp, isNA, isStringCheck };
}

// ====================================================
// 🔧 輔助函數 2: 執行檢查並生成報告
// ====================================================

function generateReport(inputItemJson, streamId) {
    const CHECK_CONDITIONS = inputItemJson.conditions;
    const inputData = Array.isArray(inputItemJson.log) ? inputItemJson.log : [inputItemJson.log];
    
    const report = {
        streamID: streamId || "N/A",
        conditions: CHECK_CONDITIONS.reduce((acc, cond) => {
            acc[cond.id] = { 
                description: cond.description, 
                status: 'Success', 
                failedLines: [], 
                field: cond.field 
            };
            return acc;
        }, {})
    };

    for (let i = 0; i < inputData.length; i++) {
        const rowData = inputData[i];
        const lineNumber = i + 1;

        for (const condition of CHECK_CONDITIONS) {
            const checkId = condition.id;
            const { met, actualValue, timestamp, isNA, isStringCheck } = executeCheck(rowData, condition);
            
            if (met) {
                let displayValue = isNA ? 'N/A' : actualValue;
                report.conditions[checkId].status = 'Failed';
                report.conditions[checkId].failedLines.push({
                    lineNumber: lineNumber,
                    timestamp: timestamp || 'N/A',
                    dataSnippet: `${condition.field}: ${displayValue}`
                });
            }
        }
    }
    return report;
}

// ====================================================
// 🔧 3. 主邏輯
// ====================================================

const finalSummary = {
    streamID: "N/A",
    conditions: {}
};

try {
    finalSummary.streamID = $node["If streamID exist1"].json.liveStreamID;
} catch (e) {
    finalSummary.streamID = "N/A";
}

for (const currentInputItem of $input.all()) {
    const inputItemJson = currentInputItem.json;
    if (!inputItemJson || !inputItemJson.conditions || !inputItemJson.log) continue;
    
    const currentReport = generateReport(inputItemJson, finalSummary.streamID);

    for (const checkId in currentReport.conditions) {
        const reportCondition = currentReport.conditions[checkId];
        if (!finalSummary.conditions[checkId]) {
            finalSummary.conditions[checkId] = reportCondition;
        } else {
            finalSummary.conditions[checkId].failedLines.push(...reportCondition.failedLines);
            if (reportCondition.status === 'Failed') {
                finalSummary.conditions[checkId].status = 'Failed';
            }
        }
    }
}

return [{ json: finalSummary }];
