const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const schema = require('../nodes/State_Schema/schema.json');
const {
  CONTRACT,
  orderedStreams,
  reconcileRows,
  resolveCanonicalConflict,
} = require('./fixtures');

const EXPECTED_TABLES = [
  'suspect_stt_candidates_v3',
  'stt_jobs_v3',
  'summary_requests_v3',
  'automation_errors_v3',
];

const workflowDir = path.resolve(__dirname, '..');
const workflowPath = path.join(workflowDir, 'workflow.json');
const manifestCodePath = path.join(workflowDir, 'nodes', 'Build_Provisioning_Manifest', 'jsCode.js');
const reportCodePath = path.join(workflowDir, 'nodes', 'Report_Expected_Schema', 'jsCode.js');

function readWorkflow() {
  return JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
}

function readManifestCode() {
  return fs.readFileSync(manifestCodePath, 'utf8');
}

function buildManifestItems() {
  return Function(readManifestCode())();
}

function loadReportBuilder() {
  delete require.cache[require.resolve(reportCodePath)];
  return require(reportCodePath).buildExpectedSchemaReport;
}

function expectedReportItems() {
  return buildManifestItems().map(({ json }) => ({
    json: {
      tableName: json.tableName,
      columnsJson: json.columnsJson,
      columnCount: json.columnCount,
      reportType: 'expected_schema_reference',
      schemaStatus: 'not_validated_by_existence_probe',
      tableCreationStatus: 'not_performed',
    },
  }));
}

test('defines only the four isolated v3 tables', () => {
  assert.deepEqual(Object.keys(schema), EXPECTED_TABLES);
  assert.ok(Object.keys(schema).every((name) => name.endsWith('_v3')));
});

test('uses primitive custom columns without system column collisions', () => {
  const forbidden = new Set(['id', 'createdAt', 'updatedAt']);
  const primitiveTypes = new Set(['string', 'number', 'boolean']);

  for (const columns of Object.values(schema)) {
    assert.ok(columns.length > 0);
    assert.ok(columns.every(({ name, type }) => !forbidden.has(name) && primitiveTypes.has(type)));
    assert.equal(new Set(columns.map(({ name }) => name)).size, columns.length);
  }
});

test('keeps canonical internal names and adapter aliases at the boundary', () => {
  assert.deepEqual(CONTRACT.modes, ['fromStart', 'fromEnd']);
  assert.deepEqual(CONTRACT.identities, ['requestKey', 'logicalJobKey', 'attemptKey']);
  assert.equal(CONTRACT.channel, 'channel');
  assert.deepEqual(CONTRACT.adapterAliases, {
    modes: { first: 'fromStart', last: 'fromEnd' },
    identities: { candidateKey: 'requestKey', jobKey: 'logicalJobKey' },
    channels: { channelID: 'channel', channelId: 'channel' },
  });
});

test('does not expose legacy aliases as internal schema fields', () => {
  for (const [tableName, columns] of Object.entries(schema)) {
    const names = columns.map(({ name }) => name);
    assert.ok(!names.includes('jobKey'));
    assert.ok(!names.includes('channelID'));
    assert.ok(!names.includes('channelId'));
    assert.equal(names.includes('candidateKey'), tableName === 'suspect_stt_candidates_v3');
  }
});

test('locks attempt, request, reconciliation, and manual review stage enums', () => {
  assert.deepEqual(CONTRACT.attemptStatuses, [
    'queued',
    'dispatching',
    'waiting_callback',
    'completed',
    'retry_pending',
    'retry_materializing',
    'retry_materialized',
    'failed',
    'timed_out',
    'manual_review',
  ]);
  assert.deepEqual(CONTRACT.requestStatuses, [
    'creating',
    'ready',
    'waiting_stt',
    'summary_dispatching',
    'summary_retry_pending',
    'manual_review',
    'completed',
    'failed',
    'creation_failed',
  ]);
  assert.deepEqual(CONTRACT.reconciliationStatuses, ['pending', 'canonical', 'duplicate']);
  assert.deepEqual(CONTRACT.manualReviewOriginalStages, [
    'ready',
    'summary_dispatching',
    'summary_retry_pending',
    'completed',
  ]);
  assert.ok(!CONTRACT.requestStatuses.includes('duplicate'));
});

test('includes reconciliation fields on every deterministic-key table', () => {
  for (const columns of Object.values(schema)) {
    const names = columns.map(({ name }) => name);
    assert.ok(names.includes('reconciliationStatus'));
    assert.ok(names.includes('canonicalRowID'));
  }
});

test('keeps suspect candidates provenance-only and automation errors masked', () => {
  const candidateNames = schema.suspect_stt_candidates_v3.map(({ name }) => name);
  const errorNames = schema.automation_errors_v3.map(({ name }) => name);

  for (const forbidden of ['status', 'attemptKey', 'dialogue', 'summaryMarkdown', 'inferenceResultJson']) {
    assert.ok(!candidateNames.includes(forbidden));
  }
  for (const forbidden of ['callbackToken', 'callbackTokenHash', 'headers', 'body', 'responseBody']) {
    assert.ok(!errorNames.includes(forbidden));
  }
  assert.ok(errorNames.includes('messageMasked'));
});

test('defines the exact candidate provenance schema', () => {
  assert.deepEqual(schema.suspect_stt_candidates_v3, [
    { name: 'candidateKey', type: 'string' },
    { name: 'runID', type: 'string' },
    { name: 'streamID', type: 'string' },
    { name: 'prevStreamID', type: 'string' },
    { name: 'sourcesJson', type: 'string' },
    { name: 'channel', type: 'string' },
    { name: 'threadTS', type: 'string' },
    { name: 'summaryRequestKey', type: 'string' },
    { name: 'reconciliationStatus', type: 'string' },
    { name: 'canonicalRowID', type: 'string' },
    { name: 'createdAtIso', type: 'string' },
    { name: 'updatedAtIso', type: 'string' },
  ]);
});

test('defines the exact stt job schema required by the provisioning contract', () => {
  assert.deepEqual(schema.stt_jobs_v3, [
    { name: 'attemptKey', type: 'string' }, { name: 'logicalJobKey', type: 'string' },
    { name: 'requestKey', type: 'string' }, { name: 'requestType', type: 'string' },
    { name: 'attempt', type: 'number' }, { name: 'role', type: 'string' },
    { name: 'streamID', type: 'string' }, { name: 'mode', type: 'string' },
    { name: 'durationMinutes', type: 'number' }, { name: 'streamContextJson', type: 'string' },
    { name: 'status', type: 'string' }, { name: 'callbackTokenHash', type: 'string' },
    { name: 'reconciliationStatus', type: 'string' }, { name: 'canonicalRowID', type: 'string' },
    { name: 'dispatchLeaseOwner', type: 'string' }, { name: 'dispatchLeaseUntilIso', type: 'string' },
    { name: 'submittedAtIso', type: 'string' }, { name: 'callbackDeadlineAtIso', type: 'string' },
    { name: 'manualReviewReason', type: 'string' }, { name: 'manualReviewAtIso', type: 'string' },
    { name: 'manualReviewResolution', type: 'string' },
    { name: 'callbackTokenExpiresAtIso', type: 'string' }, { name: 'consumedAtIso', type: 'string' },
    { name: 'channel', type: 'string' }, { name: 'threadTS', type: 'string' },
    { name: 'processingMessageTS', type: 'string' }, { name: 'dialogue', type: 'string' },
    { name: 'language', type: 'string' }, { name: 'errorCode', type: 'string' },
    { name: 'nextRetryAtIso', type: 'string' }, { name: 'retryLeaseOwner', type: 'string' },
    { name: 'retryLeaseUntilIso', type: 'string' }, { name: 'duplicateCount', type: 'number' },
    { name: 'presentationStatus', type: 'string' }, { name: 'presentationLeaseOwner', type: 'string' },
    { name: 'presentationLeaseUntilIso', type: 'string' }, { name: 'presentationAttempt', type: 'number' },
    { name: 'presentationNextRetryAtIso', type: 'string' }, { name: 'presentationErrorCode', type: 'string' },
    { name: 'transcriptUploadID', type: 'string' }, { name: 'analysisUploadID', type: 'string' },
    { name: 'processingMessageUpdatedAtIso', type: 'string' }, { name: 'createdAtIso', type: 'string' },
    { name: 'updatedAtIso', type: 'string' },
  ]);
});

test('includes summary creation, resolution, lease, and checkpoint fields', () => {
  const names = schema.summary_requests_v3.map(({ name }) => name);
  const required = [
    'creationLeaseOwner',
    'creationLeaseUntilIso',
    'orderedStreamsJson',
    'expectedLogicalJobKeysJson',
    'leaseOwner',
    'leaseUntilIso',
    'inferenceResultJson',
    'summaryMarkdown',
    'summaryUploadID',
    'summaryMessageTS',
    'manualReviewReason',
    'manualReviewAtIso',
    'manualReviewResolution',
    'manualReviewOriginalStage',
    'manualResolutionWinnerRowID',
    'manualResolutionDecisionID',
  ];

  assert.ok(required.every((name) => names.includes(name)));
});

test('defines the exact summary request schema', () => {
  assert.deepEqual(schema.summary_requests_v3, [
    { name: 'requestKey', type: 'string' }, { name: 'requestType', type: 'string' },
    { name: 'status', type: 'string' }, { name: 'creationLeaseOwner', type: 'string' },
    { name: 'reconciliationStatus', type: 'string' }, { name: 'canonicalRowID', type: 'string' },
    { name: 'creationLeaseUntilIso', type: 'string' }, { name: 'orderedStreamsJson', type: 'string' },
    { name: 'existingDialoguesJson', type: 'string' }, { name: 'expectedLogicalJobKeysJson', type: 'string' },
    { name: 'channel', type: 'string' }, { name: 'threadTS', type: 'string' },
    { name: 'coverageStatus', type: 'string' }, { name: 'availableRolesJson', type: 'string' },
    { name: 'missingRolesJson', type: 'string' }, { name: 'failedLogicalJobKeysJson', type: 'string' },
    { name: 'leaseOwner', type: 'string' }, { name: 'leaseUntilIso', type: 'string' },
    { name: 'summaryAttempt', type: 'number' }, { name: 'nextRetryAtIso', type: 'string' },
    { name: 'errorCode', type: 'string' }, { name: 'inferenceResultJson', type: 'string' },
    { name: 'summaryMarkdown', type: 'string' },
    { name: 'summaryMessageTS', type: 'string' }, { name: 'summaryUploadID', type: 'string' },
    { name: 'manualReviewReason', type: 'string' }, { name: 'manualReviewAtIso', type: 'string' },
    { name: 'manualReviewResolution', type: 'string' },
    { name: 'manualReviewOriginalStage', type: 'string' },
    { name: 'manualResolutionWinnerRowID', type: 'string' },
    { name: 'manualResolutionDecisionID', type: 'string' },
    { name: 'createdAtIso', type: 'string' }, { name: 'updatedAtIso', type: 'string' },
  ]);
});

test('defines the exact masked automation error schema', () => {
  assert.deepEqual(schema.automation_errors_v3, [
    { name: 'errorKey', type: 'string' }, { name: 'component', type: 'string' },
    { name: 'reconciliationStatus', type: 'string' }, { name: 'canonicalRowID', type: 'string' },
    { name: 'requestKey', type: 'string' }, { name: 'logicalJobKey', type: 'string' },
    { name: 'attemptKey', type: 'string' }, { name: 'executionID', type: 'string' },
    { name: 'workflowName', type: 'string' }, { name: 'nodeName', type: 'string' },
    { name: 'errorCode', type: 'string' }, { name: 'messageMasked', type: 'string' },
    { name: 'retryable', type: 'boolean' }, { name: 'createdAtIso', type: 'string' },
  ]);
});

test('provides resolved stream context in each ordered stream fixture', () => {
  assert.ok(orderedStreams.length > 0);
  for (const stream of orderedStreams) {
    assert.deepEqual(stream.streamContext, {
      liveStreamID: stream.liveStreamID,
      eligible: true,
      beginTime: 1787360400,
      endTime: 1787364000,
    });
  }
});

test('never replaces an existing canonical with a later smaller-id row', () => {
  const rows = [
    { id: 'row-z', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-z', sideEffectDone: true },
    { id: 'row-a', createdAt: '2026-08-22T00:01:00.000Z', reconciliationStatus: 'pending' },
  ];
  const reconciled = reconcileRows(rows);
  assert.equal(reconciled.canonical.id, 'row-z');
  assert.equal(reconciled.duplicates[0].canonicalRowID, 'row-z');
  assert.equal(reconciled.duplicates[0].reconciliationStatus, 'duplicate');
});

test('chooses the earliest createdAt and id only when no canonical exists', () => {
  const rows = [
    { id: 'row-b', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'pending' },
    { id: 'row-a', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'pending' },
  ];
  assert.equal(reconcileRows(rows).canonical.id, 'row-a');
});

test('uses code-unit id order for mixed-case election when no canonical exists', () => {
  const rows = [
    { id: 'row-a', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'pending' },
    { id: 'row-Z', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'pending' },
  ];

  assert.equal(reconcileRows(rows).canonical.id, 'row-Z');
});

test('concurrent canonical election converges only before checkpoints', () => {
  const result = resolveCanonicalConflict([
    { id: 'row-b', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-b' },
    { id: 'row-a', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-a' },
  ]);
  assert.equal(result.action, 'reconcile');
  assert.equal(result.canonical.id, 'row-a');
  assert.deepEqual(result.demoteRowIDs, ['row-b']);
});

test('uses code-unit id order for mixed-case canonical convergence', () => {
  const result = resolveCanonicalConflict([
    { id: 'row-a', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-a' },
    { id: 'row-Z', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-Z' },
  ]);

  assert.equal(result.action, 'reconcile');
  assert.equal(result.canonical.id, 'row-Z');
  assert.deepEqual(result.demoteRowIDs, ['row-a']);
});

test('concurrent election chooses among canonicals rather than pending rows', () => {
  const rows = [
    { id: 'row-pending', createdAt: '2026-08-21T23:59:00.000Z', reconciliationStatus: 'pending' },
    { id: 'row-b', createdAt: '2026-08-22T00:00:01.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-b' },
    { id: 'row-a', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-a' },
  ];

  assert.equal(reconcileRows(rows).canonical.id, 'row-a');
});

test('multiple canonicals with any checkpoint require manual review', () => {
  const result = resolveCanonicalConflict([
    { id: 'row-a', createdAt: '2026-08-22T00:00:00.000Z', reconciliationStatus: 'canonical' },
    { id: 'row-b', createdAt: '2026-08-22T00:00:01.000Z', reconciliationStatus: 'canonical', submittedAtIso: '2026-08-22T00:01:00.000Z' },
  ]);
  assert.deepEqual(result, { action: 'manual_review', reason: 'multiple_canonical_checkpoint_conflict' });
});

test('keeps the provisioning workflow inactive, unarchived, manual-only, and unpinned', () => {
  const workflow = readWorkflow();
  const triggerNodes = workflow.nodes.filter(({ type }) => type.toLowerCase().includes('trigger'));
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  assert.equal(workflow.name, 'Automation: provision state v3');
  assert.equal(workflow.active, false);
  assert.equal(workflow.isArchived, false);
  assert.equal(Object.hasOwn(workflow, 'pinData'), false);
  assert.deepEqual(triggerNodes.map(({ type }) => type), ['n8n-nodes-base.manualTrigger']);
  assert.ok(workflow.nodes.every(({ id }) => uuidV4.test(id)));
});

test('externalizes a self-contained manifest that exactly matches the canonical schema', () => {
  const workflow = readWorkflow();
  const buildNode = workflow.nodes.find(({ name }) => name === 'Build Provisioning Manifest');
  const code = readManifestCode();
  const output = buildManifestItems();

  assert.equal(buildNode.parameters.jsCode, '__EXTERNAL_FILE__://nodes/Build_Provisioning_Manifest/jsCode.js');
  assert.doesNotMatch(code, /\$input\.first\(\)\.json\.schemaJson/);
  assert.doesNotMatch(code, /\brequire\s*\(|\breadFile(?:Sync)?\b|\b schemaJson\b/);
  assert.deepEqual(output.map(({ json }) => json.tableName), EXPECTED_TABLES);
  assert.equal(output.length, 4);

  for (const { json } of output) {
    assert.deepEqual(JSON.parse(json.columnsJson), schema[json.tableName]);
    assert.equal(json.columnCount, schema[json.tableName].length);
  }
});

test('runs four read-only by-name Data Table probes with zero-row continuation', () => {
  const workflow = readWorkflow();
  const probe = workflow.nodes.find(({ name }) => name === 'Probe Table by Name');

  assert.deepEqual(probe.parameters, {
    resource: 'row',
    operation: 'get',
    dataTableId: { __rl: true, mode: 'name', value: '={{ $json.tableName }}' },
    matchType: 'anyCondition',
    filters: { conditions: [{ keyName: 'id', condition: 'isNotEmpty' }] },
    returnAll: false,
    limit: 1,
    options: {},
  });
  assert.equal(probe.type, 'n8n-nodes-base.dataTable');
  assert.equal(probe.typeVersion, 1.1);
  assert.equal(probe.alwaysOutputData, true);
  assert.equal(JSON.stringify(probe).includes('dt_'), false);
});

test('connects manifest, probes, and an expectation-only report without schema claims', () => {
  const workflow = readWorkflow();
  const report = workflow.nodes.find(({ name }) => name === 'Report Expected Schema');
  const serializedReport = JSON.stringify(report).toLowerCase();

  assert.deepEqual(workflow.connections, {
    'Manual Trigger': { main: [[{ node: 'Build Provisioning Manifest', type: 'main', index: 0 }]] },
    'Build Provisioning Manifest': { main: [[{ node: 'Probe Table by Name', type: 'main', index: 0 }]] },
    'Probe Table by Name': { main: [[{ node: 'Report Expected Schema', type: 'main', index: 0 }]] },
  });
  assert.ok(report);
  assert.equal(report.type, 'n8n-nodes-base.code');
  assert.equal(report.typeVersion, 2);
  assert.deepEqual(report.parameters, {
    mode: 'runOnceForAllItems',
    jsCode: '__EXTERNAL_FILE__://nodes/Report_Expected_Schema/jsCode.js',
  });
  assert.match(serializedReport, /expected/);
  assert.doesNotMatch(serializedReport, /schema[_ ]?(validated|verified)|table[_ ]?(created|provisioned)/);
});

test('rebuilds all four whitelisted report items when every table probe matches zero rows', () => {
  const buildExpectedSchemaReport = loadReportBuilder();
  const zeroProbeOutput = [];
  const output = buildExpectedSchemaReport(buildManifestItems(), zeroProbeOutput);

  assert.deepEqual(output, expectedReportItems());
  assert.equal(output.length, 4);
  assert.ok(output.every(({ json }) => Object.keys(json).length === 6));
});

test('ignores partial probe rows and never leaks their fields into the four-item report', () => {
  const buildExpectedSchemaReport = loadReportBuilder();
  const partialProbeOutput = [
    { json: { id: 'row-1', createdAt: '2026-08-23T00:00:00.000Z', privateProbeField: 'must-not-leak' } },
    { json: {} },
  ];
  const output = buildExpectedSchemaReport(buildManifestItems(), partialProbeOutput);

  assert.deepEqual(output, expectedReportItems());
  assert.equal(JSON.stringify(output).includes('row-1'), false);
  assert.equal(JSON.stringify(output).includes('privateProbeField'), false);
});

test('uses only the named Build node all-items accessor at report runtime', () => {
  const code = fs.readFileSync(reportCodePath, 'utf8');

  assert.match(code, /\$\('Build Provisioning Manifest'\)\.all\(\)/);
  assert.doesNotMatch(code, /\$input|\.item\b/);
});
