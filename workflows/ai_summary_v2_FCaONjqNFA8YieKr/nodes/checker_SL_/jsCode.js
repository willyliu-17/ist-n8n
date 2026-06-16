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
// 🔧 輔助函數
// ====================================================
function isNumericValue(value) {
	return value !== null && value !== undefined && value !== '' && !isNaN(parseFloat(value));
}

function executeCheck(rowData, condition) {
	let met = false;
	let actualValue = null;
	let timestamp = rowData.ClientTimeUTCp8 || rowData.UTCp8;
	let isNA = false;

	try {
		const rawValue = rowData[condition.field];

		if (rawValue === null || rawValue === undefined || rawValue === '') {
			isNA = true;
		} else {
			const rawIsNumeric = isNumericValue(rawValue);
			const conditionIsNumeric = isNumericValue(condition.value);

			// 數值比較：包含 > < == !=
			if (rawIsNumeric && conditionIsNumeric) {
				actualValue = parseFloat(rawValue);
				const targetNum = parseFloat(condition.value);

				switch (condition.operator) {
					case '<':
						met = actualValue < targetNum;
						break;
					case '>':
						met = actualValue > targetNum;
						break;
					case '==':
						met = actualValue === targetNum;
						break;
					case '!=':
						met = actualValue !== targetNum;
						break;
					default:
						met = false;
				}
			} else {
				// 字串比較：忽略大小寫
				actualValue = rawValue;
				const compareValue = String(rawValue).trim().toLowerCase();
				const targetValue = String(condition.value).trim().toLowerCase();

				switch (condition.operator) {
					case '==':
						met = compareValue === targetValue;
						break;
					case '!=':
						met = compareValue !== targetValue;
						break;
					default:
						met = false;
				}
			}
		}

		// 若欄位不存在且 ignoreNA === false，視為命中
		if (isNA && condition.ignoreNA === false) {
			met = true;
		}
	} catch (e) {
		// 保持 met = false
	}

	return { met, actualValue, timestamp, isNA };
}

// ====================================================
// 🔧 主邏輯 (OR 邏輯：抓第一個符合條件)
// ====================================================
if (Array.isArray(originalConditions) && Array.isArray(logs)) {
	logs.forEach((rowData, index) => {
		const matchedCondition = originalConditions.find(condition => {
			return executeCheck(rowData, condition).met;
		});

		if (matchedCondition) {
			const { actualValue, timestamp, isNA } = executeCheck(rowData, matchedCondition);

			let snippetObj = {};
			snippetObj[matchedCondition.field] = isNA ? 'N/A' : actualValue;

			if (matchedCondition.outputs) {
				matchedCondition.outputs.forEach(outField => {
					snippetObj[outField] =
						rowData[outField] === undefined || rowData[outField] === null
							? 'N/A'
							: rowData[outField];
				});
			}

			allFilteredLogs.push({
				conditionID: matchedCondition.id,
				description: matchedCondition.description,
				lineNumber: index + 1,
				timestamp: timestamp || 'N/A',
				dataSnippet: snippetObj
			});
		}
	});
}

// ====================================================
// 排序 (由舊到新)
// ====================================================
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