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

function sanitizeFilenamePart(value, fallback) {
  const sanitized = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[_\.]+|[_\.]+$/g, '')
    .slice(0, 80);
  return sanitized || fallback;
}

function buildAnalysisFile(input) {
  if (typeof input?.formattedAnalysisText !== 'string') throw new Error('Formatted analysis is missing');
  const attempt = sanitizeFilenamePart(input.attemptKey, 'attempt');
  const stream = sanitizeFilenamePart(input.streamID, 'stream');
  const mode = sanitizeFilenamePart(input.mode, 'mode');
  return {
    json: { ...input },
    binary: {
      analysis_data: {
        data: Buffer.from(`=== 直播問題分析報告 ===\n\n${input.formattedAnalysisText}`).toString('base64'),
        mimeType: 'text/plain',
        fileName: `stt_analysis_${attempt}_${stream}_${mode}.txt`,
        fileExtension: 'txt',
      },
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildAnalysisFile, formatAnalysis, parseAnalysisResponse, sanitizeFilenamePart };
}

if (typeof $input !== 'undefined') {
  const canonical = $('Guard Side Effect Owner').first().json;
  const inspection = parseAnalysisResponse($input.first().json);
  return [buildAnalysisFile({
    ...canonical,
    sttInspection: inspection,
    formattedAnalysisText: formatAnalysis(inspection),
  })];
}
