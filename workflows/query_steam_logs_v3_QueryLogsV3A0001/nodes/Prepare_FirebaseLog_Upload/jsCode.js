const item = $input.first();
const binary = item.binary?.data;

if (!binary) {
  throw new Error('FirebaseLog binary is missing');
}

return this.helpers.getBinaryDataBuffer(0, 'data').then((buffer) => [{
  json: {
    kind: 'firebaseLog',
    label: 'FirebaseLog',
    available: true,
    fileName: binary.fileName || 'FirebaseLog.xlsx',
    length: buffer.length,
  },
  binary: item.binary,
}]);
