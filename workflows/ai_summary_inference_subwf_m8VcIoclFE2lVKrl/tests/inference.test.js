const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflow.json'), 'utf8'));

test('retries transient Streamer Log Analyzer failures with bounded attempts', () => {
  const node = workflow.nodes.find((item) => item.name === 'Streamer_Log_Analyzer');
  assert.equal(node.retryOnFail, true);
  assert.equal(node.maxTries, 3);
  assert.equal(node.waitBetweenTries, 2000);
});
