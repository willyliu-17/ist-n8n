// 1. 取得前一個節點的字串
const rawOutput = $input.first().json.output;

// 2. 移除開頭與結尾的 Markdown 標記，並直接解析
const cleanText = rawOutput.replace(/^```json\s*|\s*```$/gi, '').trim();
const jsonObject = JSON.parse(cleanText);

// 3. 回傳標準 n8n 物件
return [{ json: jsonObject }];