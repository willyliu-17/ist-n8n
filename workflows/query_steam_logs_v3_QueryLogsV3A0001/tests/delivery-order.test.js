const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const workflow = JSON.parse(fs.readFileSync(path.join(root, 'workflow.json'), 'utf8'));

function node(name) {
  const value = workflow.nodes.find((item) => item.name === name);
  assert.ok(value, `Missing node: ${name}`);
  return value;
}

function edges(source) {
  return workflow.connections[source]?.main?.flat() || [];
}

function hasEdge(source, target, index) {
  return edges(source).some((edge) => edge.node === target && edge.index === index);
}

function code(name) {
  return fs.readFileSync(path.join(root, 'nodes', name, 'jsCode.js'), 'utf8');
}

function sql(name) {
  return fs.readFileSync(path.join(root, 'nodes', name, 'sqlQuery.sql'), 'utf8');
}

const preparedLogs = [
  ['Convert to StreamerLog1', 'Prepare StreamLog Upload', 0],
  ['Convert to StreamerEventLog1', 'Prepare StreamerEventLog Upload', 1],
  ['Convert to StreamCommentLog1', 'Prepare StreamCommentLog Upload', 2],
  ['Convert to MatomoLog', 'Prepare MatomoLog Upload', 3],
];

test('defaults metadata lookup to 60 days and accepts a bounded caller override', () => {
  const inputs = node('Start').parameters.workflowInputs.values;
  assert.deepEqual(inputs.find(({ name }) => name === 'lookbackDays'), { name: 'lookbackDays', type: 'number' });

  const assignment = node('Normalize Input').parameters.assignments.assignments
    .find(({ name }) => name === 'lookbackDays');
  assert.equal(assignment.type, 'number');
  assert.match(assignment.value, /return 60/);
  assert.match(assignment.value, /integer between 1 and 60/);

  const metadataQuery = node('steamID beginTime and endTime1');
  assert.deepEqual(metadataQuery.parameters.options.queryParameters.namedParameters, [{
    name: 'lookback_days',
    value: '={{ $json.lookbackDays }}',
  }]);
  assert.match(sql('steamID_beginTime_and_endTime1'), /INTERVAL @lookback_days DAY/);
  assert.doesNotMatch(sql('steamID_beginTime_and_endTime1'), /INTERVAL (?:30|60) DAY/);
});

test('all optional logs and the summary converge before delivery', () => {
  assert.deepEqual(node('Merge1').parameters, {
    mode: 'append',
    numberInputs: 5,
  });

  for (const [convert, prepare, input] of preparedLogs) {
    assert.equal(hasEdge(convert, prepare, 0), true);
    assert.equal(hasEdge(prepare, 'Merge1', input), true);
    assert.equal(node(prepare).type, 'n8n-nodes-base.code');
  }
  assert.equal(hasEdge('compose slack message', 'Merge1', 4), true);
  assert.equal(hasEdge('Merge1', 'Code', 0), true);
});

test('files use one external upload completion and zero files use one summary message', () => {
  assert.equal(hasEdge('Code', 'If Logs Exist', 0), true);
  assert.equal(hasEdge('If Logs Exist', 'Get Slack Upload URL', 0), true);
  assert.equal(hasEdge('If Logs Exist', 'Merge Slack Upload Ticket', 0), true);
  assert.equal(hasEdge('If Logs Exist', 'Send a message', 0), true);
  assert.equal(hasEdge('Get Slack Upload URL', 'Merge Slack Upload Ticket', 1), true);
  assert.equal(hasEdge('Merge Slack Upload Ticket', 'Upload Slack File Content', 0), true);
  assert.equal(hasEdge('Merge Slack Upload Ticket', 'Merge Slack Uploaded File', 0), true);
  assert.equal(hasEdge('Upload Slack File Content', 'Merge Slack Uploaded File', 1), true);
  assert.equal(hasEdge('Merge Slack Uploaded File', 'Aggregate Slack Uploaded Files', 0), true);
  assert.equal(hasEdge('Aggregate Slack Uploaded Files', 'Complete Slack Multi File Message', 0), true);
  assert.equal(hasEdge('Complete Slack Multi File Message', 'Merge Slack Completion', 1), true);
  assert.equal(hasEdge('Merge Slack Completion', 'output', 0), true);
  assert.equal(hasEdge('Send a message', 'output', 0), true);

  const getUrl = node('Get Slack Upload URL');
  assert.equal(getUrl.typeVersion, 4.3);
  assert.equal(getUrl.parameters.url, 'https://slack.com/api/files.getUploadURLExternal');
  assert.equal(getUrl.parameters.nodeCredentialType, 'slackApi');
  assert.ok(getUrl.credentials.slackApi);

  const upload = node('Upload Slack File Content');
  assert.equal(upload.typeVersion, 4.3);
  assert.equal(upload.parameters.contentType, 'binaryData');
  assert.equal(upload.parameters.inputDataFieldName, 'data');

  const complete = node('Complete Slack Multi File Message');
  assert.equal(complete.typeVersion, 4.3);
  assert.equal(complete.parameters.url, 'https://slack.com/api/files.completeUploadExternal');
  assert.equal(complete.parameters.nodeCredentialType, 'slackApi');
  assert.equal(complete.parameters.jsonBody, '={{ $json.completeBody }}');
  assert.ok(complete.credentials.slackApi);

  const summary = node('Send a message');
  assert.equal(summary.parameters.text, '={{ $json.summaryText }}');
  assert.equal(
    summary.parameters.otherOptions.thread_ts.replyValues.thread_ts,
    "={{ $('Normalize Input').first().json.threadTs }}",
  );
});

test('delivery graph has no delete, reply lookup, retry, or legacy file upload', () => {
  const forbiddenNames = [
    'Get Thread Replies',
    'Build File Message Cleanup',
    'If File Message Lookup Should Retry',
    'Delay Slack File Message Retry',
    'If File Messages Need Cleanup',
    'Delete File Message',
    'Limit Deleted File Messages',
    'Upload StreamLog1',
    'Upload StreamerEventLog1',
    'Upload StreamerCommentLog1',
    'Upload MatomoLog',
    'Send a logs1',
  ];
  for (const name of forbiddenNames) {
    assert.equal(workflow.nodes.some((item) => item.name === name), false, name);
    assert.equal(Object.hasOwn(workflow.connections, name), false, name);
  }

  for (const item of workflow.nodes) {
    assert.notEqual(item.parameters?.operation, 'delete', item.name);
    if (item.type === 'n8n-nodes-base.slack') {
      assert.notEqual(item.parameters?.resource, 'file', item.name);
    }
  }
});

test('summary composer supports partial and zero-file results', () => {
  const execute = new Function('$input', '$', code('Code'));
  const lookup = (name) => {
    if (name === 'steamID beginTime and endTime1') {
      return { first: () => ({ json: { liveStreamID: '9001', closeBy: 'close', duration: 60, type: 'OBS', deviceModel: 'Mac' } }) };
    }
    assert.equal(name, 'compose slack message');
    return { first: () => ({ json: { slackMessage: 'Metrics' } }) };
  };
  const partial = execute({
    all: () => [
      { json: { kind: 'streamerLog', label: 'StreamerLog', available: true, fileName: 'stream.xlsx', length: 10 }, binary: { data: {} } },
      { json: { kind: 'streamerEventLog', label: 'StreamerEventLog', available: false } },
      { json: { kind: 'streamCommentLog', label: 'StreamCommentLog', available: false } },
      { json: { kind: 'matomoLog', label: 'MatomoLog', available: true, fileName: 'matomo.xlsx', length: 20 }, binary: { data: {} } },
      { json: { summaryBaseText: 'Summary' } },
    ],
  }, lookup);
  assert.equal(partial.length, 2);
  assert.equal(partial.every((item) => item.json.hasFiles), true);
  assert.match(partial[0].json.summaryText, /No StreamerEventLog available/);
  assert.match(partial[0].json.summaryText, /No StreamCommentLog available/);

  const empty = execute({
    all: () => [
      { json: { kind: 'streamerLog', label: 'StreamerLog', available: false } },
      { json: { kind: 'streamerEventLog', label: 'StreamerEventLog', available: false } },
      { json: { kind: 'streamCommentLog', label: 'StreamCommentLog', available: false } },
      { json: { kind: 'matomoLog', label: 'MatomoLog', available: false } },
      { json: { summaryBaseText: 'Summary' } },
    ],
  }, lookup);
  assert.equal(empty.length, 1);
  assert.equal(empty[0].json.hasFiles, false);
  assert.deepEqual(empty[0].json.fileID, {});
  assert.match(empty[0].json.summaryText, /No StreamerLog available/);
  assert.match(empty[0].json.summaryText, /No MatomoLog available/);
});

test('uploaded file IDs become one threaded completion payload', () => {
  const execute = new Function('$input', '$', code('Aggregate_Slack_Uploaded_Files'));
  const result = execute({
    all: () => [
      { json: { file_id: 'F1', fileName: 'stream.xlsx', kind: 'streamerLog', summaryText: 'Summary' } },
      { json: { file_id: 'F2', fileName: 'matomo.xlsx', kind: 'matomoLog', summaryText: 'Summary' } },
    ],
  }, (name) => {
    assert.equal(name, 'Normalize Input');
    return { first: () => ({ json: { channelId: 'C0A4JJJKJMD', threadTs: '1788429154.000001' } }) };
  });
  assert.deepEqual(result, [{
    json: {
      completeBody: {
        files: [
          { id: 'F1', title: 'stream.xlsx' },
          { id: 'F2', title: 'matomo.xlsx' },
        ],
        channel_id: 'C0A4JJJKJMD',
        thread_ts: '1788429154.000001',
        initial_comment: 'Summary',
      },
      fileID: { streamerLog: 'F1', matomoLog: 'F2' },
    },
  }]);
});

test('final output fails closed on a Slack API error', () => {
  const execute = new Function('$input', code('output'));
  assert.throws(
    () => execute({ first: () => ({ json: { ok: false, error: 'invalid_auth' } }) }),
    /Slack delivery failed: invalid_auth/,
  );
});
