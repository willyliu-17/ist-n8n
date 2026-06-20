const items = $input.all();

// --- 1. 定義計費相關常數與函數 ---
const USD_TO_TWD = 32.5;

function getGemini3ProRate(promptTokens) {
  if (promptTokens <= 200000) {
    return { input: 2.00, output: 12.00 };
  } else {
    return { input: 4.00, output: 18.00 };
  }
}

const pricingTable = {
  "gemini-3-flash-preview": { input: 0.50, output: 3.00 },
  "gemini-1.5-pro": { input: 3.50, output: 10.50 },
  "gemini-2.5-pro": { input: 3.50, output: 10.50 },
  "gemini-1.5-flash": { input: 0.075, output: 0.30 },
  "default": { input: 0.50, output: 3.00 } 
};

return items.map(item => {
  let data = item.json.summary || {};
  const metadata = item.json.usageMetadata || {};
  const model = item.json.modelVersion || "gemini-3-flash-preview"; 
  
  const promptTokens = metadata.promptTokenCount || 0;
  const candidatesTokens = metadata.candidatesTokenCount || 0;
  const thoughtsTokens = metadata.thoughtsTokenCount || 0;
  const totalOutputTokens = candidatesTokens + thoughtsTokens;

  // --- 2. 計算費用邏輯 ---
  let rate;
  if (model.includes("gemini-3-pro")) {
    rate = getGemini3ProRate(promptTokens);
  } else if (model.includes("gemini-2.5-pro")) {
    rate = pricingTable["gemini-2.5-pro"];
  } else {
    rate = pricingTable[model] || pricingTable["default"];
  }

  const inputCostUSD = (promptTokens / 1000000) * rate.input;
  const outputCostUSD = (totalOutputTokens / 1000000) * rate.output;
  const totalCostUSD = inputCostUSD + outputCostUSD;
  const totalCostTWD = totalCostUSD * USD_TO_TWD;
  const pricingTier = model.includes("gemini-3-pro") ? (promptTokens <= 200000 ? "<= 200k" : "> 200k") : "Standard";

  // --- 3. Markdown 渲染邏輯 ---

  // 根據使用者提供的新翻譯內容更新對照表
  const labelMap = {
    'subjective_motivation': '【主觀動機與時間軸】',
    'timeline_overview': '時間軸概覽',
    'subjective_description': '主觀描述',
    'recovery_status': '修復狀態',
    'sl_analysis': '【Streamer Log 分析】',
    'sel_analysis': '【Stream Event Log 分析】',
    'summary': '【結論】',
    'fact_check': '事實查核', 
    'claimed_issue': '主播主觀判定的問題',
    'data_evidence': '證據支持',
    'is_valid_issue': '資料可靠',
    'responsibility_category': '責任歸屬類別',
    'responsibility_category_enum': '責任歸屬類別enum',
    'causal_summary': '因果總結',
    'exclusion_reasoning': '【排除與判定邏輯】',
    'level_1': 'Level 1 判定/排除依據',
    'level_2': 'Level 2 判定/排除依據'
  };

  /**
   * 格式化內容：確保星號保留，處理物件與陣列
   */
  const formatContent = (val, indent = "") => {
    if (Array.isArray(val)) {
      return val.map(v => `\n${indent}- ${formatContent(v, indent + "  ")}`).join('');
    }
    if (typeof val === 'object' && val !== null) {
      let subText = "";
      for (const k in val) {
        const title = labelMap[k] || k;
        subText += `\n${indent}- **${title}**：${formatContent(val[k], indent + "  ")}`;
      }
      return subText;
    }
    // 這裡不做任何正則替換，完全保留模型輸出的所有格式（含 ** 與 `）
    return String(val).trim();
  };

  try {
    if (typeof data === 'string') data = JSON.parse(data);
    
    let streamInfo = {};
    try {
      const streamInfoItems = $('query stream info').all();
      if (streamInfoItems && streamInfoItems.length > 0 && streamInfoItems[0].json) {
        streamInfo = streamInfoItems[0].json;
      }
    } catch(e) {}
    
    const deviceName = streamInfo.deviceModel || streamInfo.hardware || streamInfo.deviceName || 'Unknown';
    const osVersion = streamInfo.OSVersion || streamInfo.version || 'Unknown';

    mdContent = `# AI SUMMARY\n`;
    mdContent += `#### 基礎資訊\n\n`;
    mdContent += `- **裝置型號**：${deviceName}\n`;
    mdContent += `- **作業系統版本**：${osVersion}\n\n`;
    mdContent += `---\n\n`;

    for (const key in data) {
      // 渲染大章節標題 (例如：#### 【主觀動機與時間軸】)
      mdContent += `#### ${labelMap[key] || key}\n\n`;
      
      const sectionData = data[key];
      
      if (typeof sectionData === 'object' && sectionData !== null) {
        for (const subKey in sectionData) {
          const title = labelMap[subKey] || subKey;
          const content = formatContent(sectionData[subKey]);
          
          // 強制將子項標題加粗，內容緊隨其後
          mdContent += `**${title}**：${content}\n\n`;
        }
      } else {
        mdContent += `${formatContent(sectionData)}\n\n`;
      }
      mdContent += `---\n\n`;
    }
  } catch (e) {
    mdContent = `# 報告解析失敗\n\n${e.message}`;
  }

  // --- 4. 費用資訊顯示 ---
  mdContent += `#### ⚙️ 計費分析\n`;
  mdContent += `\`\`\`text\n`;
  mdContent += `[ 模型資訊 ]\n`;
  mdContent += `model: ${model}\n`;
  mdContent += `計費等級: ${pricingTier}\n\n`;
  mdContent += `[ Token 消耗 ]\n`;
  mdContent += `Prompt Tokens:    ${promptTokens.toLocaleString()}\n`;
  mdContent += `Output Tokens:    ${candidatesTokens.toLocaleString()} (回答)\n`;
  if (thoughtsTokens > 0) mdContent += `Thought Tokens:   ${thoughtsTokens.toLocaleString()} (思維鏈)\n`;
  mdContent += `Total Tokens:     ${(promptTokens + totalOutputTokens).toLocaleString()}\n\n`;
  mdContent += `[ 預估費用 ]\n`;
  mdContent += `美金總計: $${totalCostUSD.toFixed(6)} USD\n`;
  mdContent += `台幣總計: $${totalCostTWD.toFixed(4)} TWD (匯率 ${USD_TO_TWD})\n`;
  mdContent += `\`\`\``;

  return {
    json: { ...item.json },
    binary: {
      data: {
        data: Buffer.from(mdContent, 'utf-8').toString('base64'),
        fileName: `Live_Analysis_Report.md`, 
        fileExtension: 'md',
        mimeType: 'text/markdown',
      }
    }
  };
});