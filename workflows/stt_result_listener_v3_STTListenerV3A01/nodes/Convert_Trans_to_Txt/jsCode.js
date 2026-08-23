function sanitizeFilenamePart(value, fallback) {
  const sanitized = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[_\.]+|[_\.]+$/g, '')
    .slice(0, 80);
  return sanitized || fallback;
}

function buildTranscriptFile(input) {
  const language = String(input?.language || 'Unknown').trim() || 'Unknown';
  const dialogue = String(input?.dialogue || '').trim();
  if (!dialogue) throw new Error('Canonical dialogue is empty');

  const translatedDialogue = String(input?.translatedDialogue || '').trim();
  if (language !== 'zh' && !translatedDialogue) throw new Error('Translation is empty');

  let content = `Language: ${language}\n\n`;
  if (language !== 'zh') content += `=== 繁體中文翻譯 ===\n${translatedDialogue}\n\n`;
  content += `=== 原始轉錄內容 ===\n${dialogue}`;

  const attempt = sanitizeFilenamePart(input.attemptKey, 'attempt');
  const stream = sanitizeFilenamePart(input.streamID, 'stream');
  const mode = sanitizeFilenamePart(input.mode, 'mode');
  return {
    json: {
      ...input,
      summaryText: `⚠️ 翻譯/轉錄內容過長 (${(translatedDialogue || dialogue).length} 字)，已轉存為附件。`,
    },
    binary: {
      stt_data: {
        data: Buffer.from(content).toString('base64'),
        mimeType: 'text/plain',
        fileName: `stt_result_${attempt}_${stream}_${mode}.txt`,
        fileExtension: 'txt',
      },
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildTranscriptFile, sanitizeFilenamePart };
}

if (typeof $input !== 'undefined') {
  return [buildTranscriptFile($input.first().json)];
}
