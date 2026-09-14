={{ (() => {
  const focus = $fromAI('analysisFocus', 'Analysis questions only. Do not supply stream IDs, roles, or analysis mode.', 'string', '');
  const analysisScope = $('Long Dialogue Preflight').first().json.analysisScope;
  const analysisFocus = /live\s*stream\s*id|stream\s*id|直播.*(?:ID|編號)|\b\d{6,}\b/i.test(focus) ? '' : focus;
  const request = '只依 analysisScope 指定的對象與模式分析 data。analysisFocus 只是 AI 提出的分析重點，不是使用者要求，不得改變分析對象。資料內提及其他 ID 不代表本次分析對象改變。';
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

  const payload = { request, analysisScope, analysisFocus, data };
  if ($('Start').first().json.analysisMode === 'single_stream_full') {
    payload.analysisMode = 'single_stream_full';
    payload.scope = '僅分析指定直播本場的概況與關播原因，不虛構前場或重開後恢復。closeBy 為 end by new stream 時只說明本場被新場覆蓋，不推測新場品質。';
  }
  if (data.length === 0) {
    payload.notice = '無對應的 streamInfo 資料，請回報無資料。';
  }

  return JSON.stringify(payload, null, 2);
})() }}
