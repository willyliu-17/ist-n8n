const EMOJI_MAP = Object.freeze({
  '1-a': 'thermometer',
  '1-b': 'movie_camera',
  '1-c': 'memory',
  '1-d': 'boom',
  '1-e': 'cop',
  '1-f': 'internet-problems',
  '1-g': 'user',
  '2-a': 'low_battery',
  '2-b': 'gift',
  '2-c': 'signal_strength',
  '2-d': 'no_entry',
  '2-e': 'question',
});

function mapSummaryReactions(row) {
  let inference;
  try {
    inference = JSON.parse(row?.inferenceResultJson || '');
  } catch {
    throw new Error('invalid persisted inference result');
  }
  const categories = inference?.report?.summary?.responsibility_category_list;
  if (!Array.isArray(categories)) throw new Error('invalid responsibility category list');
  const stream = JSON.parse(row?.orderedStreamsJson || '[]')[0] || {};
  const context = stream.streamContext || {};
  const deviceType = String(context.type || context.deviceType || '').toLowerCase();
  const deviceModel = String(context.deviceModel || context.hardware || '').toLowerCase();
  const reactions = [];
  if (context.isOBS === true || context.isOBS === 'true') reactions.push('alphabet-white-o', 'alphabet-white-b', 'alphabet-white-s');
  if (deviceType === 'android') reactions.push('android_robot');
  if (deviceType === 'ios') reactions.push(deviceModel.includes('ipad') ? 'ipad' : 'device_iphone');
  for (const category of categories) {
    const match = String(category).match(/\[(.*?)\]/);
    if (!match) continue;
    const id = match[1];
    if (EMOJI_MAP[id]) reactions.push(EMOJI_MAP[id]);
  }
  return [...new Set(reactions)].map((emoji) => ({ emoji }));
}

if (typeof module !== 'undefined') module.exports = { mapSummaryReactions };
if (typeof $input !== 'undefined') {
  const input = $input.first().json;
  return mapSummaryReactions(input.row).map((reaction) => ({ json: { ...input, ...reaction } }));
}
