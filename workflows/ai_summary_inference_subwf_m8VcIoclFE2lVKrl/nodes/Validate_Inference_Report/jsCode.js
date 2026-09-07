function validateInferenceReport(items) {
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
  return { output };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { validateInferenceReport };
if (typeof $input !== 'undefined') return [{ json: validateInferenceReport($input.all().map(({ json }) => json)) }];
