const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildWorkflow } = require('./utils');
const {
  V3_OFFLINE_TEST_FILES,
  V3_WORKFLOW_INVENTORY,
} = require('./stt-summary-v3-inventory');

const rootDir = path.resolve(__dirname, '..');

const workflowDirs = V3_WORKFLOW_INVENTORY.map(([, directory]) => directory);
const testFiles = V3_OFFLINE_TEST_FILES;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function collectJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJsFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(entryPath);
  }
  return files;
}

function validateWorkflowGraph(workflow, relativeDir, requireDag) {
  const names = new Set(workflow.nodes.map(node => node.name));
  assert.equal(names.size, workflow.nodes.length, `${relativeDir}: duplicate node names`);

  const adjacency = new Map(workflow.nodes.map(node => [node.name, []]));
  for (const [source, outputs] of Object.entries(workflow.connections || {})) {
    assert.ok(names.has(source), `${relativeDir}: connection source ${source} is missing`);
    for (const output of Object.values(outputs)) {
      for (const branch of output) {
        for (const target of branch) {
          assert.ok(names.has(target.node), `${relativeDir}: connection target ${target.node} is missing`);
          adjacency.get(source).push(target.node);
        }
      }
    }
  }

  if (!requireDag) return;

  const visiting = new Set();
  const visited = new Set();
  function visit(name) {
    if (visiting.has(name)) throw new Error(`${relativeDir}: workflow graph contains a cycle at ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const target of adjacency.get(name)) visit(target);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of names) visit(name);
}

function validateRepairExpressions() {
  for (const relativeDir of [
    'workflows/automation_retry_and_repair_v3_AutoRepairV3A001',
    'workflows/automation_error_handler_v3_AutomationErrorV3A1',
  ]) {
    const source = fs.readFileSync(path.join(rootDir, relativeDir, 'workflow.json'), 'utf8');
    assert.equal(source.includes('={{ .'), false, `${relativeDir}: invalid expression root`);
    assert.equal(source.includes("$('"), false, `${relativeDir}: named historical lookup is forbidden`);
  }
}

function main() {
  for (const relativeDir of workflowDirs) {
    const workflow = buildWorkflow(path.join(rootDir, relativeDir));
    validateWorkflowGraph(
      workflow,
      relativeDir,
      relativeDir === 'workflows/automation_retry_and_repair_v3_AutoRepairV3A001',
    );
  }
  validateRepairExpressions();

  const externalCode = workflowDirs.flatMap(relativeDir => collectJsFiles(path.join(rootDir, relativeDir, 'nodes')));
  for (const file of externalCode) run(process.execPath, ['--check', file]);

  run(process.execPath, ['--test', ...testFiles]);
}

main();
