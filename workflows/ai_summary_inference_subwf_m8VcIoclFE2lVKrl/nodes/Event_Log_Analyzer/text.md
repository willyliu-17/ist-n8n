={{ (() => {
  const request = $fromAI('Prompt__User_Message_', ``, 'string');
  const aggregate = $('Aggregate').first().json.data || [];
  const data = [];

  aggregate.forEach(item => {
    const details = Array.isArray(item.details) ? item.details : [];
    details.forEach(detail => {
      if (detail && detail.type === 'streamEventLog') {
        data.push(detail);
      }
    });
  });

  const payload = { request, data };
  if ($('Start').first().json.analysisMode === 'single_stream_full') {
    payload.analysisMode = 'single_stream_full';
    payload.scope = '僅分析本場全部可用事件，保留時間戳，不預設存在前場、重開或抱怨；沒有抱怨時依事件證據說明，不虛構異常。';
  }
  if (data.length === 0) {
    payload.notice = '無對應的 streamEventLog 資料，請回報無資料。';
  }

  return JSON.stringify(payload, null, 2);
})() }}
