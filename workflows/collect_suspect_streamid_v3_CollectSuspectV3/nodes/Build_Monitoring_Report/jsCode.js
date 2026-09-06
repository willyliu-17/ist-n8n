const detailedList = $input.all().map(({ json }) => ({
  streamID: json.streamID,
  prevStreamID: json.prevStreamID,
  sources: JSON.parse(json.sourcesJson),
}));

return [{ json: { totalCount: detailedList.length, detailedList } }];