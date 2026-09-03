const item = $input.first();
const binary = item.binary?.data;

if (!binary) {
  throw new Error('StreamerEventLog binary is missing');
}

return this.helpers.getBinaryDataBuffer(0, 'data').then((buffer) => [{
  json: {
    kind: 'streamerEventLog',
    label: 'StreamerEventLog',
    available: true,
    fileName: binary.fileName || 'StreamerEventLog.xlsx',
    length: buffer.length,
  },
  binary: item.binary,
}]);
