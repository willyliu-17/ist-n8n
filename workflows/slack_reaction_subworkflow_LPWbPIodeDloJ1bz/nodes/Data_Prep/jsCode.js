const channelId = $input.first().json.channelID;
const threadTs = $input.first().json.threadTS;
const emojis = $input.first().json.emojis;
let waitSeconds = $input.first().json.waitSeconds;

if (!channelId || !threadTs) {
  throw new Error("Missing required parameters: channelID or threadTS");
}

if (!emojis || !Array.isArray(emojis) || emojis.length === 0) {
  return []; // Skip processing if no emojis
}

if (waitSeconds === undefined || waitSeconds === null) {
  waitSeconds = 1;
}

// Convert emojis array into separate items for the Loop node
return emojis.map((emoji) => {
  return {
    json: {
      channelId: channelId,
      threadTs: threadTs,
      emoji: emoji,
      waitSeconds: waitSeconds
    }
  };
});
