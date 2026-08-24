function parseSlackResponse(combined) {
  if (!combined || combined.kind !== 'carrier' || !combined.input || !combined.row) throw new Error('Slack response lost direct carrier');
  if (combined.ok === false || combined.error) throw new Error('invalid Slack response');
  const value = combined.nextStage === 'upload' ? combined.id : combined.ts;
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid Slack response');
  return { ...combined, checkpointField: combined.nextStage === 'upload' ? 'summaryUploadID' : 'summaryMessageTS', checkpointValue: value };
}
if (typeof module !== 'undefined') module.exports = { parseSlackResponse };
if (typeof $input !== 'undefined') {
  const item = $input.first();
  return [{ json: parseSlackResponse(item.json), binary: item.binary }];
}
