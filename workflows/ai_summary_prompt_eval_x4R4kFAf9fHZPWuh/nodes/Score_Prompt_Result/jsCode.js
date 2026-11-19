const row = $json || {};
const summary = row.summary || {};
const report = summary.report || {};
const summaryBlock = report.summary || {};

const actualCategory = String(summaryBlock.responsibility_category || '').trim();
const expectedCategory = String(row.expected_category || '').trim();
const expectedKeywords = Array.isArray(row.expected_keywords) ? row.expected_keywords : [];

const categoryMatch = expectedCategory !== '' && actualCategory === expectedCategory ? 1 : 0;

const evaluatorOutput = $('AI Keyword Evaluator').first().json || {};
const evalResult = (() => {
  if (evaluatorOutput && typeof evaluatorOutput === 'object') {
    if (evaluatorOutput.keyword_hit !== undefined) return evaluatorOutput;
    if (evaluatorOutput.output && typeof evaluatorOutput.output === 'object' && evaluatorOutput.output.keyword_hit !== undefined) {
      return evaluatorOutput.output;
    }
    if (typeof evaluatorOutput.output === 'string') {
      try {
        return JSON.parse(evaluatorOutput.output);
      } catch {}
    }
  }
  return { keyword_hit: 0, hit_keywords: [] };
})();

const keywordHit = Number(evalResult.keyword_hit || 0) === 1 ? 1 : 0;
let hitKeywords = Array.isArray(evalResult.hit_keywords)
  ? evalResult.hit_keywords.map((k) => String(k)).filter((k) => expectedKeywords.includes(k))
  : [];

if (keywordHit === 1 && hitKeywords.length === 0) {
  hitKeywords = expectedKeywords;
}

const success = categoryMatch === 1 && keywordHit === 1 ? 1 : 0;

return [{
  json: {
    case_id: row.case_id || '',
    expected_category: expectedCategory,
    actual_category: actualCategory,
    expected_keywords: expectedKeywords,
    hit_keywords: hitKeywords,
    category_match: categoryMatch,
    keyword_hit: keywordHit,
    success,
    modelVersion: row.modelVersion || '',
    usageMetadata: row.usageMetadata || {},
    summary,
    row_id: row.row_id,
    row_number: row.row_number,
    keyword_eval_raw: evalResult,
  },
}];