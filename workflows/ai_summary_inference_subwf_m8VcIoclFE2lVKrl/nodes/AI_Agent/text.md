={{ (() => {
  const aggregate = $('Aggregate').first().json.data || [];
  const liveStreamIDs = aggregate.map(item => item.liveStreamID).filter(Boolean);
  const uniqueCount = Array.from(new Set(liveStreamIDs)).length;
  const hasData = aggregate.length > 0;

  if (!hasData || uniqueCount === 0) {
    return '目前無可分析資料，請勿呼叫任何 Analyzer Tools，直接回報無資料。';
  }

  return `目前共有 ${uniqueCount} 筆 liveStreamID。請先判斷是否需要呼叫 Analyzer Tools（Streamer_Log_Analyzer / Event_Log_Analyzer / Dialogue_Analyzer / StreamInfo_Analyzer）。若資料不足就不要呼叫。`;
})() }}