const items = $input.all().filter((item) => (
  item?.json && typeof item.json === 'object' && Object.keys(item.json).length > 0
));
if (items.length !== 1) throw new Error('Expected exactly one Slack upload file item');
const file = items[0].json;
if (file.ok === false || file.error || file.errors || !/^F[A-Z0-9]+$/.test(file.id || '')) throw new Error('Slack upload item has no valid file ID');
const uploadID = file.id;
const stage = $('Guard Side Effect Owner').first().json.presentationStage;
const checkpointField = stage === 'transcript' ? 'transcriptUploadID' : 'analysisUploadID';
return [{ json: { ...$('Guard Side Effect Owner').first().json, uploadID, checkpointField, checkpointValue: uploadID } }];
