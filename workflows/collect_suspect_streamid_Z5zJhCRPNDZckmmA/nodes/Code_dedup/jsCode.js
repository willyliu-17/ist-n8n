const streamMap = {};

for (const item of $input.all()) {
  const data = item.json;

  if (!data || Object.keys(data).length <= 1 || !data.streamID) {
    continue;
  }

  const sid = data.streamID;
  const userID = data.userID;
  const currentSource = data.metricSource || data.metric_source || "Unknown";

  if (!streamMap[sid]) {
    streamMap[sid] = {
      userID: userID,
      streamID: sid,
      prevStreamID: data.prevStreamID || null,
      sources: [currentSource],
      count: 1
    };
  } else {
    if (!streamMap[sid].prevStreamID && data.prevStreamID) {
      streamMap[sid].prevStreamID = data.prevStreamID;
    }
    if (!streamMap[sid].sources.includes(currentSource)) {
      streamMap[sid].sources.push(currentSource);
    }
    streamMap[sid].count += 1;
  }
}

const cleanList = Object.values(streamMap);

const summaryText = cleanList.map(i => 
  `• StreamID: ${i.streamID} (來源: ${i.sources.join(', ')})`
).join('\n');

return [
  {
    json: {
      summaryText: summaryText,
      totalCount: cleanList.length,
      detailedList: cleanList
    }
  }
];