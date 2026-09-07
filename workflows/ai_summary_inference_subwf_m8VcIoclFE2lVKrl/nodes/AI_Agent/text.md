={{ (() => {
  const aggregate = $('Aggregate').first().json.data || [];
  const liveStreamIDs = aggregate.map(item => item.liveStreamID).filter(Boolean);
  const uniqueCount = Array.from(new Set(liveStreamIDs)).length;
  const hasData = aggregate.length > 0;

  if (!hasData || uniqueCount === 0) {
    return '目前無可分析資料，請勿呼叫任何 Analyzer Tools，直接回報無資料。';
  }

  if ($('Start').first().json.analysisMode === 'single_stream_full') {
    const details = aggregate[0].details || [];
    const dialogue = details.find(item => item.type === 'dialogue');
    return `請分析單一直播間 ${liveStreamIDs[0]} 的本場完整資料，不做前後場比較。請呼叫 Dialogue_Analyzer 判讀對話與 transcript.outcome，再依可用資料呼叫 Streamer_Log_Analyzer、Event_Log_Analyzer、StreamInfo_Analyzer。對話狀態：${dialogue?.transcript?.outcome || 'unknown'}。證據覆蓋：${JSON.stringify(dialogue?.dialogueCoverage || { kind: 'direct_transcript' })}。若對話不可用，必須明示這不是完整對話摘要。`;
  }

  return `目前共有 ${uniqueCount} 筆 liveStreamID。請先判斷是否需要呼叫 Analyzer Tools（Streamer_Log_Analyzer / Event_Log_Analyzer / Dialogue_Analyzer / StreamInfo_Analyzer）。若資料不足就不要呼叫。`;
})() }}
