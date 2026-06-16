const input = items[0].json;
const text = input.formattedAnalysisText || '';

const fileContent = `=== 直播問題分析報告 ===\n\n${text}`;

return {
  json: {
    ...input
  },
  binary: {
    analysis_data: {
      data: Buffer.from(fileContent).toString('base64'),
      mimeType: 'text/plain',
      fileName: `stt_analysis_${$('Webhook').first().json.body.webhook.context.streamid_input}_${Date.now()}.txt`
    }
  }
};