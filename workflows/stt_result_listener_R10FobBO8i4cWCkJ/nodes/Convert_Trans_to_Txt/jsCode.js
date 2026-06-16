const input = items[0].json;
const lang = input.language || 'Unknown';
const translate = input.translate || '';
const transcription = input.transcription || '';

// 格式化檔案內容
let fileContent = `Language: ${lang}\n\n`;
if (translate) {
  fileContent += `=== 繁體中文翻譯 ===\n${translate}\n\n`;
}
fileContent += `=== 原始轉錄內容 ===\n${transcription}`;

return {
  json: {
    ...input,
    summaryText: `⚠️ 翻譯/轉錄內容過長 (${(translate || transcription).length} 字)，已轉存為附件。`
  },
  binary: {
    stt_data: {
      data: Buffer.from(fileContent).toString('base64'),
      mimeType: 'text/plain',
      fileName: `stt_result_${$('Webhook').first().json.body.webhook.context.streamid_input}_${Date.now()}.txt`
    }
  }
};