const item = $input.first();
const binary = item.binary?.data;

if (!binary) {
  throw new Error('StreamCommentLog binary is missing');
}

return this.helpers.getBinaryDataBuffer(0, 'data').then((buffer) => [{
  json: {
    kind: 'streamCommentLog',
    label: 'StreamCommentLog',
    available: true,
    fileName: binary.fileName || 'StreamCommentLog.xlsx',
    length: buffer.length,
  },
  binary: item.binary,
}]);
