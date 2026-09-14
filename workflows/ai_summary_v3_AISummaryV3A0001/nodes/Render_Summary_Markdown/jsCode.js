function renderSummaryMarkdown(inference, coverageStatus, streams = []) {
  if (!inference || Array.isArray(inference) || typeof inference !== 'object' || !inference.report || typeof inference.report !== 'object') throw new Error('invalid inference report');
  const labelMap = {
    subjective_motivation: '【主觀動機與時間軸】',
    timeline_overview: '時間軸概覽',
    subjective_description: '主觀描述',
    recovery_status: '修復狀態',
    sl_analysis: '【Streamer Log 分析】',
    sel_analysis: '【Stream Event Log 分析】',
    summary: '【結論】',
    fact_check: '事實查核',
    claimed_issue: '主播主觀判定的問題',
    data_evidence: '證據支持',
    is_valid_issue: '資料可靠',
    responsibility_category: '責任歸屬類別',
    responsibility_category_enum: '責任歸屬類別 enum',
    responsibility_category_list: '責任歸屬類別清單',
    causal_summary: '因果總結',
    other_issue: '其他問題',
    exclusion_reason: '排除與判定邏輯',
    exclusion_reasoning: '排除與判定邏輯',
    level_1: 'Level 1 判定/排除依據',
    level_2: 'Level 2 判定/排除依據',
  };
  const formatContent = (value, indent = '') => {
    if (Array.isArray(value)) return value.map((item) => `\n${indent}- ${formatContent(item, `${indent}  `)}`).join('');
    if (value && typeof value === 'object') {
      return Object.entries(value).map(([key, nested]) => `\n${indent}- **${labelMap[key] || key}**：${formatContent(nested, `${indent}  `)}`).join('');
    }
    return String(value ?? '').trim();
  };
  const lines = ['# AI SUMMARY'];
  if (coverageStatus === 'partial') lines.push('', '> Partial coverage: one or more resolved streams are unavailable.');
  const reasons = { timed_out: 'STT 等待逾時，未取得轉錄資訊', failed: 'STT 處理失敗，未取得轉錄資訊', ineligible: '不符合 STT 處理條件，未取得轉錄資訊', empty: 'STT 已完成，但未辨識出文字' };
  const escape = (value) => String(value).replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>|]/g, '\\$&');
  for (const stream of streams) {
    const reason = reasons[stream.transcript?.outcome];
    if (!reason) continue;
    const errorCode = stream.transcript.errorCode;
    const detail = /^[A-Za-z0-9_.-]{1,96}$/.test(errorCode) ? `（${escape(errorCode)}）` : '';
    lines.push('', `> STT 資料狀態：${escape(stream.role)} / ${escape(stream.liveStreamID)}：${reason}${detail}。`);
  }
  for (const [key, value] of Object.entries(inference.report)) {
    lines.push('', `#### ${labelMap[key] || key}`, '');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) lines.push(`**${labelMap[nestedKey] || nestedKey}**：${formatContent(nestedValue)}`, '');
    } else {
      lines.push(formatContent(value), '');
    }
    lines.push('---');
  }
  return lines.join('\n') + '\n';
}
if (typeof module !== 'undefined') module.exports = { renderSummaryMarkdown };
if (typeof $input !== 'undefined') { const input = $input.first().json; return [{ json: { ...input, summaryMarkdown: renderSummaryMarkdown(input.inference, input.input.coverageStatus, input.input.streams) } }]; }
