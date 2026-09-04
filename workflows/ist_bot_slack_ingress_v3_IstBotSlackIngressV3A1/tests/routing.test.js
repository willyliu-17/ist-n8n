const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowDir = path.resolve(__dirname, '..');
const { buildWorkflow } = require('../../../scripts/utils');

function readWorkflow() {
  return JSON.parse(fs.readFileSync(path.join(workflowDir, 'workflow.json'), 'utf8'));
}

function nodeByName(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `Missing node: ${name}`);
  return node;
}

test('owns the only workspace Slack trigger and routes exactly two channels', () => {
  const workflow = readWorkflow();
  assert.equal(workflow.name, 'IST bot Slack ingress v3');
  assert.equal(workflow.active, false);
  assert.deepEqual(Object.fromEntries(['saveDataSuccessExecution', 'saveDataErrorExecution', 'saveManualExecutions', 'saveExecutionProgress'].map((key) => [key, workflow.settings[key]])), {
    saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true, saveExecutionProgress: false,
  });

  const triggers = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.slackTrigger');
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].typeVersion, 1);
  assert.deepEqual(triggers[0].parameters.trigger, ['message']);
  assert.equal(triggers[0].parameters.watchWorkspace, true);
  assert.equal(Object.hasOwn(triggers[0].parameters, 'channelId'), false);
  assert.match(triggers[0].webhookId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const router = nodeByName(workflow, 'Route Supported Channel');
  assert.equal(router.type, 'n8n-nodes-base.switch');
  assert.equal(router.typeVersion, 3.4);
  assert.equal(router.parameters.options.fallbackOutput, 'none');
  const rules = router.parameters.rules.values;
  assert.deepEqual(rules.map(({ conditions }) => conditions.conditions[0].rightValue), [
    'C09F0SYG57D',
    'C0A4JJJKJMD',
  ]);
  assert.ok(rules.every(({ conditions }) => conditions.conditions[0].leftValue === '={{ $json.channel }}'));

  assert.deepEqual(workflow.connections['Route Supported Channel'].main, [
    [{ node: 'Call Legacy Entry', type: 'main', index: 0 }],
    [{ node: 'Call V3 Entry', type: 'main', index: 0 }],
  ]);
  assert.doesNotThrow(() => buildWorkflow(workflowDir));
});

test('passes the complete Slack event through typed object inputs', () => {
  const workflow = readWorkflow();
  const targets = [
    ['Call Legacy Entry', 'd1Wg25BLsuGR6mAB', 'IST bot entry'],
    ['Call V3 Entry', 'IstBotEntryV3A01', 'IST bot entry v3'],
  ];

  for (const [name, id, cachedResultName] of targets) {
    const node = nodeByName(workflow, name);
    assert.equal(node.type, 'n8n-nodes-base.executeWorkflow');
    assert.equal(node.typeVersion, 1.3);
    assert.deepEqual(node.parameters.workflowId, {
      __rl: true,
      value: id,
      mode: 'list',
      cachedResultName,
    });
    assert.deepEqual(node.parameters.workflowInputs.value, { event: '={{ $json }}' });
    assert.deepEqual(node.parameters.workflowInputs.schema.map(({ id: inputId, type }) => ({ id: inputId, type })), [
      { id: 'event', type: 'object' },
    ]);
    assert.equal(node.parameters.options.waitForSubWorkflow, false);
  }
});
