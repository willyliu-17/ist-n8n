const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const resolverDir = path.resolve(__dirname, '..');
const { buildWorkflow } = require('../../../scripts/utils');
const { validateAndNormalize } = require('../nodes/Validate_and_Normalize/jsCode');
const { finalize } = require('../nodes/Finalize/jsCode');

const explicitWindow = {
  start: '2026-08-19T04:00:00+08:00',
  end: '2026-08-21T04:00:00+08:00',
};

function normalize(profile, streams = [{ liveStreamID: '123' }]) {
  return validateAndNormalize({ streams, lookupWindow: explicitWindow, profile });
}

test('validates input and uses strict numeric IDs', () => {
  const invalidInputs = [
    { streams: [], profile: 'stt' },
    { streams: Array.from({ length: 101 }, () => ({ liveStreamID: '1' })), profile: 'stt' },
    { streams: [{ liveStreamID: 123 }], profile: 'stt' },
    { streams: [{ liveStreamID: '12x' }], profile: 'stt' },
    { streams: [{ liveStreamID: '123456789012345678901' }], profile: 'stt' },
    { streams: [{ liveStreamID: '123' }], profile: 'other' },
  ];
  for (const input of invalidInputs) assert.throws(() => validateAndNormalize(input));

  const result = validateAndNormalize({
    streams: [{ liveStreamID: ' 00123 ' }],
    profile: 'stt',
  }, Date.parse('2026-08-21T00:00:00.000Z'));
  assert.equal(result.inputStreams[0].liveStreamID, '00123');
  assert.deepEqual(result.uniqueIDs, ['00123']);
  assert.equal(result.stringIdsSqlLiteral, "['00123']");
  assert.equal(result.int64IdsSqlLiteral, '[123]');
});

test('deduplicates query IDs while preserving original indexes and duplicates', () => {
  const result = normalize('core', [
    { liveStreamID: '123' },
    { liveStreamID: '456' },
    { liveStreamID: '123' },
  ]);
  assert.deepEqual(result.uniqueIDs, ['123', '456']);
  assert.equal(result.stringIdsSqlLiteral, "['123','456']");
  assert.equal(result.int64IdsSqlLiteral, null);
  assert.deepEqual(result.inputStreams, [
    { inputIndex: 0, liveStreamID: '123' },
    { inputIndex: 1, liveStreamID: '456' },
    { inputIndex: 2, liveStreamID: '123' },
  ]);
});

test('builds profile-specific SQL ID literals', () => {
  const streams = [{ liveStreamID: '123' }, { liveStreamID: '456' }];
  const core = normalize('core', streams);
  const stt = normalize('stt', streams);
  const vds = normalize('vds', streams);

  assert.equal(core.stringIdsSqlLiteral, "['123','456']");
  assert.equal(core.int64IdsSqlLiteral, null);
  assert.equal(stt.stringIdsSqlLiteral, "['123','456']");
  assert.equal(stt.int64IdsSqlLiteral, '[123,456]');
  assert.equal(vds.stringIdsSqlLiteral, "['123','456']");
  assert.equal(vds.int64IdsSqlLiteral, '[123,456]');
});

test('enforces the BigQuery INT64 upper bound only for STT and VDS', () => {
  const maximum = [{ liveStreamID: '9223372036854775807' }];
  const overflow = [{ liveStreamID: '9223372036854775808' }];

  assert.equal(normalize('stt', maximum).int64IdsSqlLiteral, '[9223372036854775807]');
  assert.equal(normalize('vds', maximum).int64IdsSqlLiteral, '[9223372036854775807]');
  assert.throws(() => normalize('stt', overflow), /BigQuery INT64 range/);
  assert.throws(() => normalize('vds', overflow), /BigQuery INT64 range/);
  assert.equal(normalize('core', overflow).stringIdsSqlLiteral, "['9223372036854775808']");
});

test('creates a deterministic default 30-day window', () => {
  const now = Date.parse('2026-08-21T00:00:00.000Z');
  const result = validateAndNormalize({ streams: [{ liveStreamID: '123' }], profile: 'core' }, now);
  assert.equal(result.windowEnd, '2026-08-21T00:00:00.000Z');
  assert.equal(result.windowStart, '2026-07-22T00:00:00.000Z');
});

test('accepts explicit offset windows and rejects malformed or oversized windows', () => {
  const result = normalize('stt');
  assert.equal(result.windowStart, explicitWindow.start);
  assert.equal(result.windowEnd, explicitWindow.end);

  const invalidWindows = [
    { start: '2026-08-19T04:00:00', end: explicitWindow.end },
    { start: '2026-02-30T04:00:00+08:00', end: explicitWindow.end },
    { start: explicitWindow.end, end: explicitWindow.start },
    { start: '2026-07-01T00:00:00Z', end: '2026-08-02T00:00:00Z' },
  ];
  for (const lookupWindow of invalidWindows) {
    assert.throws(() => validateAndNormalize({ streams: [{ liveStreamID: '123' }], lookupWindow, profile: 'stt' }));
  }
  assert.throws(() => validateAndNormalize({
    streams: [{ liveStreamID: '123' }],
    lookupWindow: null,
    profile: 'stt',
  }));
});

test('finalizes complete rows for all profiles', () => {
  const core = finalize(normalize('core'), [{
    liveStreamID: '123', userID: 'u1', openID: 'host', beginTime: '10', endTime: '20',
    duration: '10', closeBy: 'normal', streamMode: 'normal', vliverModel: '0', isOBS: false,
  }])[0];
  assert.equal(core.status, 'found');
  assert.equal(core.source, 'datamart');
  assert.equal(core.eligible, true);

  const stt = finalize(normalize('stt'), [{
    liveStreamID: '123', userID: 'u1', beginTime: '10', endTime: '20', duration: '10',
    caption: 'host 正在開播', region: 'TW', vliverModel: '0', appVersion: '1.2.3',
    deviceType: 'ios', isOBS: false, closeBy: 'normal', streamMode: 'normal', deviceModel: 'phone',
    osVersion: '18', publicIP: '192.0.2.1', ipRegion: 'TW', openID: 'host',
  }])[0];
  assert.equal(stt.status, 'found');
  assert.equal(stt.source, 'livestream_v2');
  assert.equal(stt.eligible, true);
  assert.equal(stt.duration, 10);
  assert.equal(stt.isOBS, false);

  const vds = finalize(normalize('vds'), [{
    liveStreamID: '123', userID: 'u1', beginTime: '10', endTime: '20', publishSec: '0',
    region: 'TW', ipRegion: 'TW',
  }])[0];
  assert.equal(vds.status, 'found');
  assert.equal(vds.eligible, true);
  assert.equal(vds.publishSec, 0);
});

test('distinguishes partial and not_found and computes eligibility', () => {
  const partialEligible = finalize(normalize('core'), [{
    liveStreamID: '123', userID: 'u1', openID: null, beginTime: 10, endTime: 20,
    duration: 10, closeBy: 'normal', streamMode: 'normal', vliverModel: 0, isOBS: false,
  }])[0];
  assert.equal(partialEligible.status, 'partial');
  assert.equal(partialEligible.eligible, true);
  assert.deepEqual(partialEligible.missingFields, ['openID']);

  const invalidTime = finalize(normalize('stt'), [{
    liveStreamID: '123', userID: 'u1', beginTime: 20, endTime: 20, duration: -1,
    caption: 'host 正在開播', region: 'TW', vliverModel: 0, appVersion: '1',
    deviceType: 'ios', closeBy: 'normal', streamMode: 'normal', deviceModel: 'phone',
    osVersion: '18', publicIP: '192.0.2.1', ipRegion: 'TW', openID: 'host',
  }])[0];
  assert.equal(invalidTime.status, 'partial');
  assert.equal(invalidTime.eligible, false);
  assert.ok(invalidTime.missingFields.includes('duration'));
  assert.ok(invalidTime.missingFields.includes('endTime'));

  const notFound = finalize(normalize('vds'), [{}])[0];
  assert.equal(notFound.status, 'not_found');
  assert.equal(notFound.eligible, false);
  assert.equal(notFound.liveStreamID, '123');
});

test('strictly rejects non-decimal and non-finite numeric field values', () => {
  const invalidValues = [
    false,
    true,
    [],
    {},
    '0x10',
    -1,
    '-1',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    'NaN',
    'Infinity',
  ];

  for (const publishSec of invalidValues) {
    const result = finalize(normalize('vds'), [{
      liveStreamID: '123', userID: 'u1', beginTime: 10, endTime: 20, publishSec,
      region: 'TW', ipRegion: 'TW',
    }])[0];
    assert.equal(result.status, 'partial');
    assert.equal(result.eligible, false);
    assert.equal(result.publishSec, null);
    assert.ok(result.missingFields.includes('publishSec'));
  }

  for (const publishSec of [0, 1.5, '0', '001.50']) {
    const result = finalize(normalize('vds'), [{
      liveStreamID: '123', userID: 'u1', beginTime: 10, endTime: 20, publishSec,
      region: 'TW', ipRegion: 'TW',
    }])[0];
    assert.equal(result.status, 'found');
    assert.equal(result.eligible, true);
    assert.equal(result.publishSec, Number(publishSec));
  }
});

test('preserves original output order and duplicates', () => {
  const normalized = normalize('vds', [
    { liveStreamID: '2' },
    { liveStreamID: '1' },
    { liveStreamID: '2' },
  ]);
  const rows = [
    { liveStreamID: '1', userID: 'u1', beginTime: 1, endTime: 2, publishSec: 0, region: 'TW', ipRegion: 'TW' },
    { liveStreamID: '2', userID: 'u2', beginTime: 3, endTime: 4, publishSec: 1, region: 'JP', ipRegion: 'JP' },
  ];
  const result = finalize(normalized, rows);
  assert.deepEqual(result.map(({ inputIndex, liveStreamID }) => ({ inputIndex, liveStreamID })), [
    { inputIndex: 0, liveStreamID: '2' },
    { inputIndex: 1, liveStreamID: '1' },
    { inputIndex: 2, liveStreamID: '2' },
  ]);
});

test('builds external files and enforces workflow topology', () => {
  const workflow = buildWorkflow(resolverDir);
  assert.equal(workflow.id, 'StreamMetaV3A001');
  assert.equal(workflow.active, false);
  assert.equal(workflow.isArchived, false);
  assert.equal(workflow.nodes.length, 7);
  assert.ok(workflow.nodes.every((node) => !JSON.stringify(node.parameters).includes('__EXTERNAL_FILE__://')));

  const forbiddenTypes = new Set([
    'n8n-nodes-base.slack', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.dataTable',
    'n8n-nodes-base.wait', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.manualTrigger',
  ]);
  assert.ok(workflow.nodes.every((node) => !forbiddenTypes.has(node.type)));
  const switchOutputs = workflow.connections['Switch Profile'].main;
  assert.deepEqual(switchOutputs.map((output) => output[0].node), ['Query Core', 'Query STT', 'Query VDS']);
  for (const queryName of ['Query Core', 'Query STT', 'Query VDS']) {
    assert.equal(workflow.connections[queryName].main[0][0].node, 'Finalize');
  }

  const expectedParameters = [
    {
      name: 'window_start',
      value: "={{ $('Validate and Normalize').first().json.windowStart }}",
    },
    {
      name: 'window_end',
      value: "={{ $('Validate and Normalize').first().json.windowEnd }}",
    },
  ];
  const queryNodes = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.googleBigQuery');
  assert.deepEqual(queryNodes.map((node) => node.name), ['Query Core', 'Query STT', 'Query VDS']);
  const expectedIDInterpolations = {
    'Query Core': ["{{ $('Validate and Normalize').first().json.stringIdsSqlLiteral }}"],
    'Query STT': [
      "{{ $('Validate and Normalize').first().json.stringIdsSqlLiteral }}",
      "{{ $('Validate and Normalize').first().json.int64IdsSqlLiteral }}",
    ],
    'Query VDS': ["{{ $('Validate and Normalize').first().json.int64IdsSqlLiteral }}"],
  };
  for (const node of queryNodes) {
    assert.ok(node.parameters.sqlQuery.startsWith('='));
    assert.deepEqual(node.parameters.sqlQuery.match(/\{\{[\s\S]*?\}\}/g), expectedIDInterpolations[node.name]);
    assert.deepEqual(node.parameters.options.queryParameters.namedParameters, expectedParameters);
  }
});

test('keeps SQL fixed, narrow, parameterized, and batch-only', () => {
  const sqlFiles = {
    core: fs.readFileSync(path.join(resolverDir, 'nodes/Query_Core/sqlQuery.sql'), 'utf8'),
    stt: fs.readFileSync(path.join(resolverDir, 'nodes/Query_STT/sqlQuery.sql'), 'utf8'),
    vds: fs.readFileSync(path.join(resolverDir, 'nodes/Query_VDS/sqlQuery.sql'), 'utf8'),
  };
  assert.match(sqlFiles.core, /`media17-1119\.MatomoDataMart\.LiveStreamWithViewerInfo`/);
  assert.match(sqlFiles.stt, /`media17-1119\.mongodb\.LiveStreamV2`/);
  assert.match(sqlFiles.stt, /FROM `media17-1119\.MatomoDataMart\.LiveStreamWithViewerInfo`/);
  assert.match(sqlFiles.stt, /NULLIF\(TRIM\(streamer\.openID\), ''\) AS openID/);
  assert.match(sqlFiles.stt, /stream\.isOBS AS isOBS\s+FROM `media17-1119\.MatomoDataMart\.LiveStreamWithViewerInfo`/);
  assert.equal((sqlFiles.stt.match(/stream\.isOBS AS isOBS/g) || []).length, 1);
  assert.equal((sqlFiles.stt.match(/identity\.isOBS AS isOBS/g) || []).length, 2);
  assert.match(sqlFiles.stt, /LEFT JOIN identity\s+ON identity\.liveStreamID = CAST\(stream\.liveStreamID AS STRING\)\s+AND identity\.userID = stream\.userID/);
  assert.doesNotMatch(sqlFiles.stt, /`media17-1119\.mongodb\.User`/);
  assert.doesNotMatch(sqlFiles.stt, /正在開播|SPLIT\(caption/);
  assert.match(sqlFiles.vds, /`media17-1119\.mongodb\.LiveStreamV2`/);

  for (const [profile, sql] of Object.entries(sqlFiles)) {
    assert.doesNotMatch(sql, /SELECT\s+\*/i);
    assert.match(sql, /TIMESTAMP\(@window_start\)/);
    assert.match(sql, /TIMESTAMP\(@window_end\)/);
    assert.equal((sql.match(/\bSELECT\b/gi) || []).length, profile === 'stt' ? 2 : 1);
    assert.doesNotMatch(sql, /\$json|\$node|Start/);
  }
  assert.match(sqlFiles.core, /IN\s+UNNEST\(\{\{ \$\('Validate and Normalize'\)\.first\(\)\.json\.stringIdsSqlLiteral \}\}\)/);
  assert.match(sqlFiles.stt, /IN\s+UNNEST\(\{\{ \$\('Validate and Normalize'\)\.first\(\)\.json\.int64IdsSqlLiteral \}\}\)/);
  assert.match(sqlFiles.stt, /IN\s+UNNEST\(\{\{ \$\('Validate and Normalize'\)\.first\(\)\.json\.stringIdsSqlLiteral \}\}\)/);
  assert.match(sqlFiles.vds, /IN\s+UNNEST\(\{\{ \$\('Validate and Normalize'\)\.first\(\)\.json\.int64IdsSqlLiteral \}\}\)/);
  assert.doesNotMatch(sqlFiles.core, /int64IdsSqlLiteral/);
  assert.doesNotMatch(sqlFiles.vds, /stringIdsSqlLiteral/);
  assert.match(sqlFiles.core, /beginTime >= TIMESTAMP\(@window_start\)/);
  assert.match(sqlFiles.core, /beginTime < TIMESTAMP\(@window_end\)/);
  assert.match(sqlFiles.stt, /beginTime >= UNIX_SECONDS\(TIMESTAMP\(@window_start\)\)/);
  assert.match(sqlFiles.vds, /beginTime >= UNIX_SECONDS\(TIMESTAMP\(@window_start\)\)/);

  const projectedFields = {
    core: ['liveStreamID', 'userID', 'openID', 'beginTime', 'endTime', 'duration', 'closeBy', 'streamMode', 'vliverModel', 'isOBS'],
    stt: ['liveStreamID', 'userID', 'beginTime', 'endTime', 'duration', 'region', 'vliverModel', 'appVersion', 'deviceType', 'isOBS', 'openID'],
    vds: ['liveStreamID', 'userID', 'beginTime', 'endTime', 'publishSec', 'region', 'ipRegion'],
  };
  for (const [profile, sql] of Object.entries(sqlFiles)) {
    const orderFields = profile === 'stt'
      ? 'stream\\.beginTime DESC,\\s+stream\\.endTime DESC,\\s+stream\\.userID DESC'
      : `beginTime DESC,\\s+endTime DESC,\\s+${profile === 'core' ? 'streamerID' : 'userID'} DESC`;
    assert.match(sql, new RegExp(`ORDER BY\\s+${orderFields},\\s+TO_JSON_STRING\\(STRUCT\\(`));
    const fingerprint = sql.match(/TO_JSON_STRING\(STRUCT\(([\s\S]*?)\)\) DESC\s*\) = 1/);
    assert.ok(fingerprint, `${profile} must have a deterministic projected-fields fingerprint`);
    for (const field of projectedFields[profile]) {
      assert.match(fingerprint[1], new RegExp(`\\bAS ${field}\\b`));
    }
  }
});
