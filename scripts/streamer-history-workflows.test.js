const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildWorkflow } = require('./utils');
const { inventory } = require('./build-streamer-history');
const schema = require('./streamer-history-schema');
const H = require('./streamer-history-core');
const { parseBotItem } = require('../workflows/ist_bot_entry_v3_IstBotEntryV3A01/nodes/Command_parser/jsCode');
const { buildRootIdentityUpdates } = require('../workflows/collect_suspect_streamid_v3_CollectSuspectV3/nodes/Prepare_Root_Identity_Update/buildIdentity');
const workflows = new Map(inventory.map(([, directory, id]) => [id, buildWorkflow(path.join(__dirname, '../workflows', directory))]));

test('history writes are restricted to dedicated index tables with explicit per-column CAS', () => {
  for (const workflow of workflows.values()) {
    assert.equal(workflow.active, workflow.id !== 'HistoryNotifyV1A');
    for (const node of workflow.nodes.filter(n => n.type === 'n8n-nodes-base.dataTable' && n.parameters.operation !== 'get')) {
      const table = node.parameters.dataTableId.value;
      assert.ok(Object.values(H.TABLES).includes(table));
      assert.notEqual(table, H.TABLES.reviews);
      for (const key of ['id', 'createdAt', 'updatedAt']) assert.ok(!Object.hasOwn(node.parameters.columns.value, key));
      if (node.parameters.operation === 'update') {
        assert.equal(node.parameters.matchType, 'allConditions');
        assert.deepEqual(node.parameters.filters.conditions.map(c => c.keyName), ['id', ...schema[table].map(c => c.name)]);
      }
    }
  }
});
test('lookup is read-only and skips jobs unless inline identity is absent', () => {
  assert.ok(workflows.get('HistoryLookupV1A').nodes.every(n => ['executeWorkflowTrigger', 'code', 'dataTable'].some(type => n.type === 'n8n-nodes-base.' + type)));
  const request = workflows.get('HistoryRequestV1');
  assert.equal(request.connections['Context Source'].main[0][0].node, 'Read Matching Jobs');
  assert.equal(request.connections['Context Source'].main[1][0].node, 'Build Records');
  assert.ok(workflows.get('HistoryLookupV1A').nodes.filter(n => n.type === 'n8n-nodes-base.dataTable').every(n => n.parameters.operation === 'get'));
});
test('native loops continue after an ineligible notification and keep one item per CAS writer', () => {
  const notify = workflows.get('HistoryNotifyV1A');
  assert.equal(notify.nodes.find(n => n.name === 'Deliver One').alwaysOutputData, true);
  for (const workflow of workflows.values()) {
    for (const node of workflow.nodes.filter(n => n.type === 'n8n-nodes-base.splitInBatches')) {
      assert.equal(node.parameters.batchSize, 1);
      const done = workflow.nodes.find(n => n.name === workflow.connections[node.name].main[0][0].node);
      assert.equal(done.type, 'n8n-nodes-base.limit');
      assert.equal(done.parameters.maxItems, 1);
      assert.ok(workflow.connections[node.name].main[1].length);
    }
  }
});
test('daily poll claims before Slack and verifies a separate completion checkpoint', () => {
  const w = workflows.get('HistoryDeliverV1');
  assert.equal(w.connections['Claim Delivery'].main[0][0].node, 'Send History');
  assert.equal(w.connections['Send History'].main[0][0].node, 'Sent Operation');
  assert.equal(w.connections['Send History'].main[1][0].node, 'Delivery Unknown');
  const slack = w.nodes.find(n => n.name === 'Send History');
  assert.notEqual(slack.retryOnFail, true);
  assert.equal(w.nodes.find(n => n.name === 'Checkpoint Delivery').parameters.workflowId.value, 'HistoryWriteV1A1');
});
test('streamer command routes both allowed channels without adding a stream command', () => {
  for (const channel of [H.CHANNEL, 'C0A4JJJKJMD']) {
    const parsed = parseBotItem({ channel, ts: '1790000000.000001', event_ts: '1790000000.000001', text: '!history streamer fixture-user' });
    assert.equal(parsed.dispatchKey, 'v3:history:streamer');
    assert.deepEqual(parsed.positionals, ['fixture-user']);
  }
  assert.equal(parseBotItem({ channel: 'CUNKNOWN', ts: '1790000000.000001', event_ts: '1790000000.000001', text: '!history streamer fixture-user' }), null);
});
test('root identity updates preserve candidate ownership and source details across multiple streamers', () => {
  const rows = [1, 2].map(index => ({ candidate: { candidateKey: `candidate-${index}`, streamID: String(index), prevStreamID: String(index + 10), channel: H.CHANNEL, threadTS: `1790000000.00000${index}`, sourcesJson: '["commentCaptionKeyword","endByNewStream"]' }, stream: { role: 'current', liveStreamID: String(index), streamContext: { liveStreamID: String(index), userID: `user-${index}`, openID: `open-${index}` } } }));
  const output = buildRootIdentityUpdates(rows, { searchKeywords: 'fixture-keyword' });
  for (const [index, row] of output.entries()) {
    assert.equal(row.threadTS, rows[index].candidate.threadTS);
    assert.ok(row.text.includes(`userID: user-${index + 1}`));
    assert.ok(row.text.includes(`openID: open-${index + 1}`));
    assert.ok(row.text.includes('fixture-keyword'));
    assert.ok(row.text.includes('PrevStreamID:'));
  }
  assert.throws(() => buildRootIdentityUpdates([rows[0], rows[0]], {}), /duplicate_root/);
  assert.throws(() => buildRootIdentityUpdates([{ ...rows[0], stream: rows[1].stream }], {}), /identity_mismatch/);
  rows[0].stream.streamContext = {};
  assert.ok(buildRootIdentityUpdates([rows[0]], {}).at(0).text.includes('openID: 未取得'));
});
test('root updates use existing resolver output and daily markers survive query configuration', () => {
  const w = buildWorkflow(path.join(__dirname, '../workflows/collect_suspect_streamid_v3_CollectSuspectV3'));
  assert.ok(w.connections['Reassemble Resolver Output'].main[0].some(e => e.node === 'Prepare Root Identity Update'));
  const config = w.nodes.find(n => n.name === 'Build Candidate Query Config');
  assert.equal(config.parameters.assignments.assignments.find(a => a.name === 'historyTriggerKind').value, '={{ $json.historyTriggerKind }}');
  assert.equal(w.nodes.find(n => n.name === 'Update Root Identity').parameters.ts, '={{ $json.threadTS }}');
});
test('generated history code embeds the current shared contract', () => {
  const core = fs.readFileSync(path.join(__dirname, 'streamer-history-core.js'), 'utf8');
  for (const workflow of workflows.values()) {
    for (const node of workflow.nodes.filter(n => n.type === 'n8n-nodes-base.code' && n.parameters.jsCode.includes('History.'))) assert.ok(node.parameters.jsCode.startsWith(core), `${workflow.name}:${node.name}`);
  }
});
