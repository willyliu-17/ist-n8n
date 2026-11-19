={{ (() => {
  const aggregate = $('Aggregate').first().json.data || [];
  const liveStreamIDs = aggregate.map(item => item.liveStreamID).filter(Boolean);
  const uniqueCount = Array.from(new Set(liveStreamIDs)).length;
  const analysisScope = $('Long Dialogue Preflight').first().json.analysisScope;
  const hasData = analysisScope.availableStreamIDs.length > 0;
  const context = `可信分析範圍：${JSON.stringify(analysisScope)}。analysisScope 必須原樣放入結構化輸出。只能分析 requestedStreams，availableStreamIDs 表示有證據的場次，missingDialogueRoles 表示對話缺口；不得自行補 ID 或把工具要求稱為使用者要求。`;

  if (!hasData || uniqueCount === 0) {
    return `${context}\n目前無可分析資料，請勿呼叫任何 Analyzer Tools，直接回報無資料。`;
  }

  if ($('Start').first().json.analysisMode === 'single_stream_full') {
    const details = aggregate[0].details || [];
    const dialogue = details.find(item => item.type === 'dialogue');
    return `${context}\n請分析單一直播間 ${liveStreamIDs[0]} 的本場完整資料，不做前後場比較。請呼叫 Dialogue_Analyzer 判讀對話與 transcript.outcome，再依可用資料呼叫 Streamer_Log_Analyzer、Event_Log_Analyzer、StreamInfo_Analyzer、Firebase_Log_Analyzer。對話狀態：${dialogue?.transcript?.outcome || 'unknown'}。證據覆蓋：${JSON.stringify(dialogue?.dialogueCoverage || { kind: 'direct_transcript' })}。若對話不可用，必須明示這不是完整對話摘要。`;
  }

  return `${context}\n目前共有 ${uniqueCount} 筆 liveStreamID：${liveStreamIDs.join(', ')}。依既有角色比較，角色 unspecified 時不可自行推定前後順序。若只剩一場證據，仍須明示比較限制，不得改成 single_stream_full。請先判斷是否需要呼叫 Analyzer Tools（Streamer_Log_Analyzer / Event_Log_Analyzer / Dialogue_Analyzer / StreamInfo_Analyzer / Firebase_Log_Analyzer）。若資料不足就不要呼叫。`;
})() }}
