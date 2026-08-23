function parseAnalysisResponse(response) {
  const raw = response?.content?.parts?.[0]?.text;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Gemini analysis response is empty');
  const normalized = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let inspection;
  try {
    inspection = JSON.parse(normalized);
  } catch {
    throw new Error('Gemini analysis response is malformed');
  }
  if (!Array.isArray(inspection)) throw new Error('Gemini analysis response must be an array');
  for (const item of inspection) {
    if (!item || typeof item.issue !== 'string' || typeof item.ref !== 'string') {
      throw new Error('Gemini analysis item is malformed');
    }
  }
  return inspection;
}

function formatAnalysis(inspection) {
  return inspection.map((item, index) => (
    `[問題 ${index + 1}]\n描述: ${item.issue}\n引用: "${item.ref}"`
  )).join('\n\n----------------\n\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatAnalysis, parseAnalysisResponse };
}

if (typeof $input !== 'undefined') {
  const canonical = $('Guard Side Effect Owner').first().json;
  const inspection = parseAnalysisResponse($input.first().json);
  return [{ json: { ...canonical, sttInspection: inspection, formattedAnalysisText: formatAnalysis(inspection) } }];
}
