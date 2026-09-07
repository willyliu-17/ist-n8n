={{ (() => {
  const request = $fromAI('Prompt__User_Message_', ``, 'string');
  const aggregate = $('Aggregate').first().json.data || [];
  const data = [];

  aggregate.forEach(item => {
    const details = Array.isArray(item.details) ? item.details : [];
    details.forEach(detail => {
      if (detail && detail.type === 'streamerLog') {
        data.push(detail);
      }
    });
  });

  const payload = { request, data };
  if ($('Start').first().json.analysisMode === 'single_stream_full') {
    payload.analysisMode = 'single_stream_full';
    payload.scope = '僅分析本場所有可用推流指標，保留時間戳，不預設存在前場、重開或異常；沒有資料不等於正常。';
  }
  if (data.length === 0) {
    payload.notice = '無對應的 streamerLog 資料，請回報無資料。';
  }

  return JSON.stringify(payload, null, 2);
})() }}
