const item = $input.first();
const binary = item.binary?.data;

if (!binary) {
  throw new Error('StreamerLog binary is missing');
}

return this.helpers.getBinaryDataBuffer(0, 'data').then((buffer) => [{
  json: {
    kind: 'streamerLog',
    label: 'StreamerLog',
    available: true,
    fileName: binary.fileName || 'StreamerLog.xlsx',
    length: buffer.length,
  },
  binary: item.binary,
}]);
