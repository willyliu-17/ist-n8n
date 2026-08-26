const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { collectCredentialReferences, collectDataTableReferences } = require('./deploy-utils');
const {
  V3_DATA_TABLE_NAMES,
  V3_EXTERNAL_WORKFLOW_DEPENDENCIES,
  V3_OFFLINE_TEST_FILES,
  V3_TENCENT_CALLBACK_EXCLUSION,
  V3_WORKFLOW_INVENTORY,
} = require('./stt-summary-v3-inventory');
const { buildWorkflow } = require('./utils');

const root = path.resolve(__dirname, '..');
const manifest = require('./final-review-findings.json');
function readOptional(relativePath) {
  const absolutePath = path.resolve(root, relativePath);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : null;
}

const specSources = Object.freeze({
  addendum: readOptional('docs/superpowers/specs/2026-08-21-ist-n8n-bq-stt-optimization-v3-isolation-addendum.md'),
  design: readOptional('docs/superpowers/specs/2026-08-21-ist-n8n-bq-stt-optimization-design.md'),
  plan: readOptional('docs/superpowers/plans/2026-08-22-stt-summary-async-v3.md'),
});
const workflowEntries = V3_WORKFLOW_INVENTORY.map(([name, directory]) => ({
  directory,
  name,
  workflow: buildWorkflow(path.resolve(root, directory)),
}));

const linkedAssertions = Object.freeze({
  'concurrent-election': ['workflows/automation_provision_state_v3_AutomationProvV3A1/tests/contracts.test.js', 'concurrent canonical election converges only before checkpoints'],
  'checkpoint-conflict': ['workflows/automation_provision_state_v3_AutomationProvV3A1/tests/contracts.test.js', 'multiple canonicals with any checkpoint require manual review'],
  'request-one-checkpoint-winner': ['workflows/summary_coordinator_v3_SummaryCoordV3A1/tests/coordinator.test.js', 'manual resolution selects one checkpoint and identical earliest checkpoint'],
  'request-identical-checkpoints': ['workflows/summary_coordinator_v3_SummaryCoordV3A1/tests/coordinator.test.js', 'manual resolution selects one checkpoint and identical earliest checkpoint'],
  'request-conflicting-checkpoints-failed': ['workflows/summary_coordinator_v3_SummaryCoordV3A1/tests/coordinator.test.js', 'manual failed decision follows fixed canonical protocol without attempts'],
  'request-loser-partial-retry': ['workflows/summary_coordinator_v3_SummaryCoordV3A1/tests/coordinator.test.js', 'manual loser partial failure retries same immutable winner with zero side effects'],
  'request-pre-finalize-crash-retry': ['workflows/summary_coordinator_v3_SummaryCoordV3A1/tests/coordinator.test.js', 'manual crash before final patch reuses fixed winner and finalizes invariant'],
  'retry-created-resolution': ['workflows/automation_retry_and_repair_v3_AutoRepairV3A001/tests/repair.test.js', 'approved manual retry builds a deterministic next row then transitions the old row'],
  'retry-success-summary': ['workflows/summary_coordinator_v3_SummaryCoordV3A1/tests/coordinator.test.js', 'resolved manual and retry_materialized follow exact next canonical attempt'],
  'p2-zero-create': ['scripts/deploy-utils.test.js', 'P2 creates exact inert skeletons for zero exact-name matches and returns all IDs'],
  'p2-inert-reuse': ['scripts/deploy-utils.test.js', 'P2 reuses one inactive empty inert exact-name workflow without POST'],
  'p2-rerun': ['scripts/deploy-utils.test.js', 'P2 rerun reuses every created ID and performs no additional POST'],
  'p2-fail-closed': ['scripts/deploy-utils.test.js', 'P2 fails closed for duplicate exact-name workflows before POST'],
  'source-name-placeholder': ['scripts/deploy-utils.test.js', 'collectDataTableReferences accepts repeated four-table exact-name placeholders only'],
  'p3-table-map-fail-closed': ['scripts/deploy-utils.test.js', 'P3 compares every readback custom column against canonical name, type, and order'],
  'p4-data-table-remap': ['scripts/deploy-utils.test.js', 'P4 deep-clones and remaps Data Tables, selectors, and credentials before PUT, then confirms inactive'],
  'deployed-id-locator': ['scripts/deploy-utils.test.js', 'P4 stops later PUTs when post-PUT GET returns a non-P3 Data Table target ID'],
  'explicit-base': ['workflows/ist_bot_entry_v3_IstBotEntryV3A01/tests/routing.test.js', 'builds exact default and explicit lookup windows'],
  'bounded-pairing-extension': ['workflows/ist_bot_entry_v3_IstBotEntryV3A01/tests/routing.test.js', 'extends only outside an explicit base and caps each side at six hours'],
  'previous-fallback-window': ['workflows/ist_bot_entry_v3_IstBotEntryV3A01/tests/routing.test.js', 'keeps previousFallbackWindow separate and bounded to 30 days'],
});

function assertConnectionTargets(workflow, label) {
  const names = new Set(workflow.nodes.map(({ name }) => name));
  const ids = new Set(workflow.nodes.map(({ id }) => id));
  assert.equal(names.size, workflow.nodes.length, `${label}: duplicate node name`);
  assert.equal(ids.size, workflow.nodes.length, `${label}: duplicate node ID`);
  for (const [source, outputs] of Object.entries(workflow.connections || {})) {
    assert.ok(names.has(source), `${label}: missing connection source ${source}`);
    for (const branches of Object.values(outputs)) {
      for (const branch of branches) {
        for (const target of branch) {
          assert.ok(names.has(target.node), `${label}: missing connection target ${target.node}`);
        }
      }
    }
  }
}

function assertLinkedTest([relativePath, title]) {
  assert.ok(V3_OFFLINE_TEST_FILES.includes(relativePath), `${relativePath} is not in the offline test inventory`);
  const source = fs.readFileSync(path.resolve(root, relativePath), 'utf8');
  assert.ok(
    source.includes(`test('${title}'`) || source.includes(`test(\"${title}\"`),
    `${relativePath} is missing deterministic assertion: ${title}`,
  );
}

function assertManifestShape() {
  assert.equal(manifest.manifest, 'final-review-findings');
  assert.ok(Array.isArray(manifest.items) && manifest.items.length > 0);
  const ids = manifest.items.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, 'finding IDs must be unique');
  for (const item of manifest.items) {
    assert.equal(typeof item.id, 'string');
    for (const key of ['specSections', 'planTasks', 'tests', 'gates']) {
      assert.ok(Array.isArray(item[key]), `${item.id}.${key} must be an array`);
    }
    assert.ok(item.specSections.length > 0, `${item.id} must link a spec section`);
    assert.ok(item.planTasks.length > 0, `${item.id} must link a plan task`);
    assert.ok(item.tests.length > 0, `${item.id} must link a deterministic test`);
    assert.ok(item.planTasks.every(value => Number.isInteger(value) && value >= 1 && value <= 15));
    assert.ok(item.gates.every(value => /^P(?:[1-9]|1[0-4])$/.test(value)));
    for (const reference of item.specSections) {
      const separator = reference.indexOf(':');
      assert.ok(separator > 0, `${item.id} has invalid spec reference ${reference}`);
      const document = reference.slice(0, separator);
      const section = reference.slice(separator + 1);
      assert.ok(Object.hasOwn(specSources, document), `${item.id} has unknown spec document ${document}`);
      if (specSources[document] === null) continue;
      if (document === 'plan') {
        assert.match(specSources.plan, new RegExp(`^## .*${section.replaceAll('-', ' ')}`, 'im'));
      } else {
        assert.match(specSources[document], new RegExp(`^#{1,6} ${section.replace('.', '\\.')}(?:\\.|\\s|$)`, 'm'));
      }
    }
  }
}

test('loads and assembles every workflow from the authoritative inventory', () => {
  assert.equal(workflowEntries.length, V3_WORKFLOW_INVENTORY.length);
  assert.equal(new Set(V3_WORKFLOW_INVENTORY.map(([name]) => name)).size, V3_WORKFLOW_INVENTORY.length);
  assert.equal(new Set(V3_WORKFLOW_INVENTORY.map(([, directory]) => directory)).size, V3_WORKFLOW_INVENTORY.length);
  for (const { directory, name, workflow } of workflowEntries) {
    assert.equal(workflow.name, name, directory);
    assert.equal(workflow.active, false, directory);
    assertConnectionTargets(workflow, directory);
  }
});

test('uses the approved execution retention values across the v3 inventory', () => {
  const expected = {
    saveDataSuccessExecution: 'all',
    saveDataErrorExecution: 'all',
    saveManualExecutions: true,
    saveExecutionProgress: false,
  };
  for (const { directory, workflow } of workflowEntries) {
    const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, workflow.settings?.[key]]));
    assert.deepEqual(actual, expected, directory);
  }
});

test('keeps every source Data Table reference as one authoritative static name placeholder', () => {
  const references = collectDataTableReferences(workflowEntries.map(({ workflow }) => workflow));
  assert.ok(references.length > V3_DATA_TABLE_NAMES.length);
  assert.deepEqual(new Set(references.map(({ tableName }) => tableName)), new Set(V3_DATA_TABLE_NAMES));
});

test('pins Data Table nodes to the version registered by Production n8n 1.123.27', () => {
  const nodes = workflowEntries.flatMap(({ workflow }) => workflow.nodes)
    .filter(({ type }) => type === 'n8n-nodes-base.dataTable');
  assert.ok(nodes.length > 0);
  assert.ok(nodes.every(({ typeVersion }) => typeVersion === 1));
});

test('pins Execute Workflow Trigger nodes to the version registered by Production n8n 1.123.27', () => {
  const nodes = workflowEntries.flatMap(({ workflow }) => workflow.nodes)
    .filter(({ type }) => type === 'n8n-nodes-base.executeWorkflowTrigger');
  assert.ok(nodes.length > 0);
  assert.ok(nodes.every(({ typeVersion }) => typeVersion === 1.1));
});

test('resolves every static Execute Workflow selector against the authoritative inventory', () => {
  const byName = new Map(workflowEntries.map(({ name, workflow }) => [name, workflow]));
  const byId = new Map(workflowEntries.map(({ workflow }) => [workflow.id, workflow]));
  const externalByName = new Map(V3_EXTERNAL_WORKFLOW_DEPENDENCIES);
  for (const { directory, workflow } of workflowEntries) {
    for (const node of workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.executeWorkflow')) {
      const selector = node.parameters?.workflowId;
      if (typeof selector === 'string') {
        if (selector.startsWith('=')) continue;
        assert.ok(byId.has(selector), `${directory}:${node.name} has unknown workflow ID ${selector}`);
        continue;
      }
      assert.ok(selector && typeof selector === 'object', `${directory}:${node.name} has no selector`);
      if (byName.has(selector.cachedResultName)) {
        assert.equal(selector.value, byName.get(selector.cachedResultName).id, `${directory}:${node.name} selector mismatch`);
      } else {
        assert.equal(selector.value, externalByName.get(selector.cachedResultName), `${directory}:${node.name} external selector mismatch`);
      }
    }
  }
  assert.deepEqual(
    new Set(V3_EXTERNAL_WORKFLOW_DEPENDENCIES.map(([name]) => name)),
    new Set(['AI SUMMARY Inference SubWF', 'Debug STT service', 'IST bot entry']),
  );
});

test('limits the execution-bound callback exclusion to the exact Tencent inventory directory', () => {
  assert.equal(V3_TENCENT_CALLBACK_EXCLUSION, 'workflows/tencent_realtime_vds_v3_TencentVDSV3A001');
  assert.equal(workflowEntries.filter(({ directory }) => directory === V3_TENCENT_CALLBACK_EXCLUSION).length, 1);
  const excluded = workflowEntries.find(({ directory }) => directory === V3_TENCENT_CALLBACK_EXCLUSION);
  const excludedSource = JSON.stringify(excluded.workflow);
  assert.match(excludedSource, /n8n-nodes-base\.wait/);
  assert.match(excludedSource, /resumeUrl/);
  for (const { directory, workflow } of workflowEntries.filter(({ directory }) => directory !== V3_TENCENT_CALLBACK_EXCLUSION)) {
    const source = JSON.stringify(workflow);
    assert.doesNotMatch(source, /n8n-nodes-base\.wait/, directory);
    assert.doesNotMatch(source, /resumeUrl/, directory);
  }
});

test('keeps C09 routing isolated to the single Slack ingress and callback tokens out of HTTP URLs', () => {
  for (const { directory, workflow } of workflowEntries) {
    const source = JSON.stringify(workflow);
    if (directory === 'workflows/ist_bot_slack_ingress_v3_IstBotSlackIngressV3A1') {
      assert.match(source, /C09F0SYG57D/, directory);
    } else {
      assert.doesNotMatch(source, /C09F0SYG57D/, directory);
    }
    for (const node of workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.httpRequest')) {
      assert.doesNotMatch(String(node.parameters?.url || ''), /callbackToken|callbackTokenHash/i, `${directory}:${node.name}`);
    }
  }
  for (const directory of [
    'workflows/query_steam_logs_v3_QueryLogsV3A0001',
    V3_TENCENT_CALLBACK_EXCLUSION,
  ]) {
    const source = JSON.stringify(workflowEntries.find(entry => entry.directory === directory).workflow);
    assert.match(source, /C0A4JJJKJMD/, directory);
  }
});

test('keeps exactly one Slack trigger in the v3 inventory', () => {
  const owners = workflowEntries.flatMap(({ directory, workflow }) => workflow.nodes
    .filter(({ type }) => type === 'n8n-nodes-base.slackTrigger')
    .map(({ name }) => ({ directory, name })));
  assert.deepEqual(owners, [{
    directory: 'workflows/ist_bot_slack_ingress_v3_IstBotSlackIngressV3A1',
    name: 'Slack Trigger',
  }]);
});

test('keeps suspect collection inactive and manual-only', () => {
  const { workflow } = workflowEntries.find(({ directory }) =>
    directory === 'workflows/collect_suspect_streamid_v3_CollectSuspectV3');
  const triggers = workflow.nodes.filter(({ type }) => type.toLowerCase().includes('trigger'));
  assert.equal(workflow.active, false);
  assert.deepEqual(triggers.map(({ type }) => type), ['n8n-nodes-base.manualTrigger']);
});

test('executes the Query Logs checker with the Code node input contract', () => {
  const source = fs.readFileSync(path.resolve(
    root,
    'workflows/query_steam_logs_v3_QueryLogsV3A0001/nodes/checker/jsCode.js',
  ), 'utf8');
  const run = Function('$input', '$node', source);
  const output = run(
    { all: () => [{ json: {
      conditions: [{ id: 'bitrate', description: 'Low bitrate', field: 'bitrate', operator: '<', value: 100, ignoreNA: true }],
      log: [{ bitrate: 50, UTCp8: '2026-08-25T00:00:00+08:00' }],
    } }] },
    { 'If streamID exist1': { json: { liveStreamID: '9001' } } },
  );
  assert.equal(output[0].json.streamID, '9001');
  assert.equal(output[0].json.conditions.bitrate.status, 'Failed');
  assert.equal(output[0].json.conditions.bitrate.failedLines.length, 1);
});

test('collects only credential reference metadata and never credential values', () => {
  const references = collectCredentialReferences(workflowEntries.map(({ workflow }) => workflow));
  assert.ok(references.length > 0);
  assert.equal(new Set(references.map(({ type, name, id }) => `${type}\0${name}\0${id}`)).size, references.length);
  assert.ok(references.every(reference => Object.keys(reference).sort().join(',') === 'id,name,type'));
});

test('links every final-review finding to registered deterministic assertions', () => {
  assertManifestShape();
  const manifestTestIDs = manifest.items.flatMap(({ tests }) => tests);
  for (const testID of manifestTestIDs) {
    if (testID === 'manifest-completeness') {
      assertManifestShape();
      continue;
    }
    assert.ok(Object.hasOwn(linkedAssertions, testID), `unregistered manifest test ID: ${testID}`);
    assertLinkedTest(linkedAssertions[testID]);
  }
  assert.deepEqual(
    new Set(manifestTestIDs.filter(testID => testID !== 'manifest-completeness')),
    new Set(Object.keys(linkedAssertions)),
  );
});
