const item = $json;

function parseMaybeJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

const aggregateData = (() => {
  const parsed = parseMaybeJson(item.aggregateData, []);
  return Array.isArray(parsed) ? parsed : [];
})();

const evalConfigRaw = parseMaybeJson(item.evalConfig, {});
const evalConfig = {
  modelName: evalConfigRaw.modelName || 'gemini-3.0-pro-preview',
  temperature:
    typeof evalConfigRaw.temperature === 'number'
      ? evalConfigRaw.temperature
      : Number(evalConfigRaw.temperature ?? 0.1),
};

const expectedKeywords = (() => {
  if (Array.isArray(item.expected_keywords)) return item.expected_keywords;
  if (typeof item.expected_keywords === 'string') {
    return item.expected_keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
  }
  return [];
})();

return [{
  json: {
    case_id: item.case_id || `row-${item.row_number ?? 0}`,
    expected_category: String(item.expected_category || ''),
    expected_keywords: expectedKeywords,
    evalConfig,
    aggregateData,
    row_id: item.row_id,
    row_number: item.row_number,
  },
}];