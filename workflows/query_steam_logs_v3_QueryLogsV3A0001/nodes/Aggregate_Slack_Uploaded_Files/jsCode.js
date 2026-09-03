const items = $input.all();

if (items.length === 0 || items.length > 4) {
  throw new Error('Slack upload completion received an invalid file count');
}

const files = [];
const fileID = {};
let summaryText = '';

for (const item of items) {
  const { file_id: id, fileName: title, kind } = item.json;
  if (typeof id !== 'string' || !id || typeof title !== 'string' || !title || typeof kind !== 'string') {
    throw new Error('Slack upload completion received invalid file metadata');
  }
  files.push({ id, title });
  fileID[kind] = id;
  summaryText ||= item.json.summaryText || '';
}

if (!summaryText) {
  throw new Error('Slack upload completion is missing the summary text');
}

const normalized = $('Normalize Input').first().json;
const threadTs = normalized.threadTs;
if (typeof threadTs !== 'string' || !threadTs) {
  throw new Error('Slack upload completion is missing the thread timestamp');
}

return [{
  json: {
    completeBody: {
      files,
      channel_id: normalized.channelId,
      thread_ts: threadTs,
      initial_comment: summaryText,
    },
    fileID,
  },
}];
