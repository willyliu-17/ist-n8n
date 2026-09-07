={{ (() => {
  const request = $fromAI('Prompt__User_Message_', ``, 'string');
  const aggregate = $('Aggregate').first().json.data || [];
  const data = [];

  aggregate.forEach(item => {
    const details = Array.isArray(item.details) ? item.details : [];
    details.forEach(detail => {
      if (detail && detail.type === 'streamInfo') {
        data.push(detail);
      }
    });
  });

  const payload = { request, data };
  if ($('Start').first().json.analysisMode === 'single_stream_full') {
    payload.analysisMode = 'single_stream_full';
    payload.scope = '僅分析指定直播本場的概況與關播原因，不虛構前場或重開後恢復。closeBy 為 end by new stream 時只說明本場被新場覆蓋，不推測新場品質。';
  }
  if (data.length === 0) {
    payload.notice = '無對應的 streamInfo 資料，請回報無資料。';
  }

  return JSON.stringify(payload, null, 2);
})() }}
