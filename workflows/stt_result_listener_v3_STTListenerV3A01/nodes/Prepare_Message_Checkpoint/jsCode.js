const owner = $('Guard Side Effect Owner').first().json;
return [{ json: {
  ...owner,
  checkpointField: 'processingMessageUpdatedAtIso',
  checkpointValue: new Date().toISOString(),
} }];
