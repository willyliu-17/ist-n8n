function validateInferenceReport(items, expectedScope) {
  if (!Array.isArray(items) || items.length !== 1) throw new Error('summary_model_output_invalid');
  const output = items[0]?.output;
  const report = output?.report;
  const summary = report?.summary;
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(output) || !object(report) || !object(summary)
    || !object(report.subjective_motivation) || !object(summary.fact_check)
    || !object(summary.exclusion_reason)) throw new Error('summary_model_output_invalid');
  const fields = [
    [report.subjective_motivation, ['timeline_overview', 'subjective_description', 'recovery_status']],
    [report, ['sl_analysis', 'sel_analysis']],
    [summary, ['responsibility_category', 'causal_summary', 'other_issue']],
    [summary.fact_check, ['claimed_issue', 'data_evidence', 'is_valid_issue']],
    [summary.exclusion_reason, ['level_1', 'level_2']],
  ];
  if (fields.some(([record, keys]) => keys.some((key) => typeof record[key] !== 'string'))
    || !Array.isArray(summary.responsibility_category_list)
    || summary.responsibility_category_list.some((value) => typeof value !== 'string')
    || !summary.causal_summary.trim()) throw new Error('summary_model_output_invalid');
  const fail = () => { throw new Error('summary_analysis_scope_mismatch'); };
  const same = (left, right) => {
    if (Array.isArray(right)) return Array.isArray(left) && left.length === right.length && right.every((value, index) => same(left[index], value));
    if (object(right)) return object(left) && Object.keys(left).length === Object.keys(right).length && Object.keys(right).every((key) => same(left[key], right[key]));
    return left === right;
  };
  if (!object(expectedScope) || !same(output.analysisScope, expectedScope)) fail();
  const allowed = new Set(expectedScope.requestedStreams.map((stream) => stream.liveStreamID));
  // Check explicit target claims only; event IDs, timestamps, and quoted log references are not targets.
  const targetClaim = /(?:用戶|使用者|用户|user)[^。.!?\n]{0,32}(?:請求|请求|要求|request)|(?:本次|本報告|本报告)[^。.!?\n]{0,24}(?:分析對象|分析对象|分析範圍|分析范围)|(?:analysis|requested)\s+(?:targets?|scope|streams?)/i;
  for (const [record, keys] of fields) {
    for (const key of keys) {
      for (const sentence of record[key].split(/[。.!?\n]/)) {
        const claim = targetClaim.exec(sentence);
        if (!claim) continue;
        const claimText = sentence.slice(claim.index).split(/日誌|日志|\blogs?\b|事件/i)[0];
        const claimed = [...claimText.matchAll(/(?:live\s*stream\s*IDs?|stream\s*IDs?|直播(?:間|间)?\s*(?:ID|編號|编号))\s*(?:[12]\s*[:：]\s*)?[：:（(]?\s*[`*]*\s*([0-9][0-9`*\s,，、/／()（）-]*)/gi)];
        for (const match of claimed) {
          if ((match[1].match(/\d+/g) || []).some((id) => !allowed.has(id))) fail();
        }
      }
    }
  }
  return { output };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { validateInferenceReport };
if (typeof $input !== 'undefined') {
  const items = $input.all().map(({ json }) => json);
  const scope = typeof $ === 'function' ? $('Long Dialogue Preflight').first().json.analysisScope : undefined;
  return [{ json: validateInferenceReport(items, scope) }];
}
