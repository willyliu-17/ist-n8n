const item = $input.first();
const binary = item.binary?.data;

if (!binary) {
  throw new Error('MatomoLog binary is missing');
}

return this.helpers.getBinaryDataBuffer(0, 'data').then((buffer) => [{
  json: {
    kind: 'matomoLog',
    label: 'MatomoLog',
    available: true,
    fileName: binary.fileName || 'MatomoLog.xlsx',
    length: buffer.length,
  },
  binary: item.binary,
}]);
