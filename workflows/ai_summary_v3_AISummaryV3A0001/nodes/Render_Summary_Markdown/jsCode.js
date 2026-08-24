function renderSummaryMarkdown(inference, coverageStatus) {
  if (!inference || Array.isArray(inference) || typeof inference !== 'object' || !inference.report || typeof inference.report !== 'object') throw new Error('invalid inference report');
  const lines = ['# AI Summary'];
  if (coverageStatus === 'partial') lines.push('', '> Partial coverage: one or more resolved streams are unavailable.');
  for (const [key, value] of Object.entries(inference.report)) lines.push('', `## ${key}`, '', typeof value === 'string' ? value : '```json\n' + JSON.stringify(value, null, 2) + '\n```');
  return lines.join('\n') + '\n';
}
if (typeof module !== 'undefined') module.exports = { renderSummaryMarkdown };
if (typeof $input !== 'undefined') { const input = $input.first().json; return [{ json: { ...input, summaryMarkdown: renderSummaryMarkdown(input.inference, input.input.coverageStatus) } }]; }
