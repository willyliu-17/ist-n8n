={{ (() => {
  const request = $fromAI('Prompt__User_Message_', ``, 'string');
  const aggregate = $('Aggregate').first().json.data || [];
  const data = [];

  aggregate.forEach(item => {
    const details = Array.isArray(item.details) ? item.details : [];
    details.forEach(detail => {
      if (detail && detail.type === 'dialogue') {
        data.push(detail);
      }
    });
  });

  const payload = { request, data };
  if ($('Start').first().json.analysisMode === 'single_stream_full') {
    payload.analysisMode = 'single_stream_full';
    payload.scope = '僅分析本場全部可用對話或完整分段證據；不預設前場、重開或異常，保留時間戳與資料限制。';
  }
  if (data.length === 0) {
    payload.notice = '無對應的 dialogue 資料，請回報無資料。';
  }

  return JSON.stringify(payload, null, 2);
})() }}
