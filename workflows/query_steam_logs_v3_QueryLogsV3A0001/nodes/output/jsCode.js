const response = $input.first().json;

if (response.ok === false) {
  throw new Error(`Slack delivery failed: ${response.error || 'unknown_error'}`);
}

return [{
  json: {
    fileID: response.fileID || {},
  },
}];
