// 設定匯率與不同型號的費率 (每百萬 tokens 的美金價格)
const USD_TO_TWD = 32.5;

// 定義計費函數，處理 Gemini 3 Pro 的階層式定價
function getGemini3ProRate(promptTokens) {
  if (promptTokens <= 200000) {
    return { input: 2.00, output: 12.00 }; // 提示詞 <= 20萬
  } else {
    return { input: 4.00, output: 18.00 }; // 提示詞 > 20萬
  }
}

const pricingTable = {
  "gemini-3-flash-preview": { input: 0.50, output: 3.00 },
  "gemini-1.5-pro": { input: 3.50, output: 10.50 },
  "gemini-1.5-flash": { input: 0.075, output: 0.30 },
  "default": { input: 0.50, output: 3.00 } 
};

// 處理傳入的數據
return items.map(item => {
  const metadata = item.json.usageMetadata || {};
  const model = item.json.modelVersion || "";
  
  const promptTokens = metadata.promptTokenCount || 0;
  const candidatesTokens = metadata.candidatesTokenCount || 0;
  const thoughtsTokens = metadata.thoughtsTokenCount || 0;
  
  // 決定費率
  let rate;
  if (model.includes("gemini-3-pro")) {
    rate = getGemini3ProRate(promptTokens);
  } else {
    rate = pricingTable[model] || pricingTable["default"];
  }
  
  // 輸出計費 = 回答(Candidates) + 思維鏈(Thoughts)
  const totalOutputTokens = candidatesTokens + thoughtsTokens;
  
  const inputCostUSD = (promptTokens / 1000000) * rate.input;
  const outputCostUSD = (totalOutputTokens / 1000000) * rate.output;
  const totalCostUSD = inputCostUSD + outputCostUSD;
  const totalCostTWD = totalCostUSD * USD_TO_TWD;

  return {
    json: {
      model_used: model,
      pricing_tier: model.includes("gemini-3-pro") ? (promptTokens <= 200000 ? "<= 200k" : "> 200k") : "Standard",
      usage: {
        prompt: promptTokens,
        candidates: candidatesTokens,
        thoughts: thoughtsTokens,
        total_billed_output: totalOutputTokens
      },
      analysis: {
        input_rate_usd: rate.input,
        output_rate_usd: rate.output,
        cost_usd: totalCostUSD.toFixed(6),
        cost_twd: totalCostTWD.toFixed(4)
      }
    }
  };
});