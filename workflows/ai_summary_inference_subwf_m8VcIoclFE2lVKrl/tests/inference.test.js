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

test('prompts distinguish transcript outcomes and prohibit raw IP output', () => {
  const prompt = (name) => fs.readFileSync(path.join(__dirname, '..', 'nodes', name, 'options_systemMessage.md'), 'utf8');

  assert.match(prompt('Dialogue_Analyzer'), /transcript\.outcome/);
  assert.match(prompt('Dialogue_Analyzer'), /empty.*不是查詢失敗/);
  assert.match(prompt('StreamInfo_Analyzer'), /publicIP.*不可輸出完整 IP/);
  assert.match(prompt('Streamer_Log_Analyzer'), /UserIP.*IPRegion.*不可輸出完整 IP/);
  assert.match(prompt('AI_Agent'), /最終輸出禁止包含完整 IP/);
});
