function parseJsonArray(value, fieldName) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${fieldName} must be valid JSON`); }
  if (!Array.isArray(parsed)) throw new Error(`${fieldName} must encode an array`);
  return parsed;
}

function verifyCoverage(request, attemptRows) {
  if (!request || request.status !== 'creating' || request.reconciliationStatus !== 'canonical') throw new Error('Coverage requires canonical creating request');
  const streams = parseJsonArray(request.orderedStreamsJson, 'orderedStreamsJson');
  const dialogues = JSON.parse(request.existingDialoguesJson);
  const expectedKeys = parseJsonArray(request.expectedLogicalJobKeysJson, 'expectedLogicalJobKeysJson');
  const byKey = new Map();
  for (const row of attemptRows) {
    if (row.requestKey !== request.requestKey) throw new Error('Attempt request key mismatch');
    if (!expectedKeys.includes(row.logicalJobKey)) continue;
    if (row.reconciliationStatus === 'canonical') {
      if (byKey.has(row.logicalJobKey)) throw new Error('Multiple canonical attempts for logical job');
      byKey.set(row.logicalJobKey, row);
    }
  }
  for (const key of expectedKeys) {
    const row = byKey.get(key);
    if (!row || row.attemptKey !== `${key}:1` || row.status !== 'queued') throw new Error(`Expected canonical queued attempt is not readable: ${key}`);
  }
  const availableRoles = streams.filter((stream) => dialogues[stream.role]?.dialogue).map((stream) => stream.role);
  const missingRoles = streams.filter((stream) => !dialogues[stream.role]?.dialogue).map((stream) => stream.role);
  const waiting = expectedKeys.length > 0;
  return {
    status: waiting ? 'waiting_stt' : 'ready',
    coverageStatus: waiting ? 'waiting_stt' : availableRoles.length === streams.length ? 'complete' : 'partial',
    availableRolesJson: JSON.stringify(availableRoles),
    missingRolesJson: JSON.stringify(missingRoles),
    failedLogicalJobKeysJson: '[]',
    dispatchAttempts: expectedKeys.map((key) => ({ attemptKey: `${key}:1` })),
  };
}

function acceptedResult(request) {
  if (!request || request.reconciliationStatus !== 'canonical') throw new Error('Accepted result requires canonical request');
  return {
    accepted: true,
    requestKey: request.requestKey,
    requestType: request.requestType,
    status: request.status,
    channel: request.channel,
    threadTS: request.threadTS,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { acceptedResult, verifyCoverage };

if (typeof $input !== 'undefined') {
  const requests = $('Re-read Creation Owner').all().map(({ json }) => json);
  const request = requests.find((row) => row.reconciliationStatus === 'canonical');
  const rows = $input.all().map(({ json }) => json).filter((row) => row.id);
  return [{ json: {
    ...request,
    ...verifyCoverage(request, rows),
    expectedCreationLeaseOwner: request.creationLeaseOwner,
  } }];
}
