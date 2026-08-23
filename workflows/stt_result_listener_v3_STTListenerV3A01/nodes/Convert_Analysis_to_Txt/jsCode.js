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
  const text = input.formattedAnalysisText;
  const attempt = sanitizeFilenamePart(input.attemptKey, 'attempt');
  const stream = sanitizeFilenamePart(input.streamID, 'stream');
  const mode = sanitizeFilenamePart(input.mode, 'mode');

  return {
    json: { ...input },
    binary: {
      analysis_data: {
        data: Buffer.from(`=== 直播問題分析報告 ===\n\n${text}`).toString('base64'),
        mimeType: 'text/plain',
        fileName: `stt_analysis_${attempt}_${stream}_${mode}.txt`,
        fileExtension: 'txt',
      },
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildAnalysisFile, sanitizeFilenamePart };
}

if (typeof $input !== 'undefined') {
  return [buildAnalysisFile($input.first().json)];
}
