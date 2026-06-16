const input = items[0].json;
const inspectionData = input.sttInspection || [];
let analysisText = "";

if (Array.isArray(inspectionData)) {
  // 將 Array 轉為易讀文字
  analysisText = inspectionData.map((item, index) => {
    return `[問題 ${index + 1}]\n描述: ${item.issue}\n引用: "${item.ref}"`;
  }).join('\n\n----------------\n\n');
} else {
  analysisText = JSON.stringify(inspectionData, null, 2);
}

return {
  json: {
    ...input,
    formattedAnalysisText: analysisText
  }
};