const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowDir = path.resolve(__dirname, '..');
const { buildWorkflow } = require('../../../scripts/utils');
const { CHANNEL, parseBotItem } = require('../nodes/Command_parser/jsCode');

function readWorkflow() {
  return JSON.parse(fs.readFileSync(path.join(workflowDir, 'workflow.json'), 'utf8'));
}

function nodeByName(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `Missing node: ${name}`);
  return node;
}

test('accepts one typed Slack event object and preserves legacy routing', () => {
  const event = {
    channel: CHANNEL,
    ts: '1787364000.000002',
    event_ts: '1787364000.000002',
    thread_ts: '1787364000.000001',
    text: '!stt stream 9001 last 5',
  };
  const parsed = parseBotItem({ event });
  assert.equal(parsed.routeKey, 'stt:stream');
  assert.deepEqual(parsed.positionals, ['9001', 'last', '5']);
  assert.equal(parsed.thread_ts, event.thread_ts);
  assert.equal(parseBotItem({ event: { ...event, bot_id: 'B01' } }), null);
  assert.throws(() => parseBotItem({ event: [] }), /event must be an object/);
  assert.throws(() => parseBotItem({ event: { ...event, channel: 'C0A4JJJKJMD' } }), /channel is not allowed/);
  assert.throws(() => parseBotItem({ event: { ...event, ts: '' } }), /event timestamp/);
  assert.throws(() => parseBotItem({ event: { ...event, event_ts: '' } }), /event timestamp/);
  assert.throws(() => parseBotItem({ event: { ...event, thread_ts: 'invalid' } }), /thread timestamp/);
});

test('starts only from a typed event input and no longer owns a Slack webhook', () => {
  const workflow = readWorkflow();
  const starts = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.executeWorkflowTrigger');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].typeVersion, 1.1);
  assert.deepEqual(starts[0].parameters.workflowInputs.values, [{ name: 'event', type: 'object' }]);
  assert.equal(workflow.nodes.some(({ type }) => type === 'n8n-nodes-base.slackTrigger'), false);
  assert.deepEqual(workflow.connections.Start.main, [[{ node: 'Command parser', type: 'main', index: 0 }]]);

  const send = nodeByName(workflow, 'Send a message');
  assert.equal(send.parameters.channelId.value, "={{ $('Command parser').first().json.channel }}");
  assert.equal(send.parameters.otherOptions.thread_ts.replyValues.thread_ts, "={{ $('Command parser').first().json.thread_ts }}");
  assert.doesNotThrow(() => buildWorkflow(workflowDir));
});
