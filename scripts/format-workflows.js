const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderWorkflow } = require('./sync-files');

// Format local definitions only; embedded strings and external files stay intact.
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) throw new Error('Usage: node scripts/format-workflows.js [--check]');
const check = args.includes('--check');
const root = path.resolve(__dirname, '../workflows');
const changes = [];
let inspected = 0;
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filename = path.join(root, entry.name, 'workflow.json');
    if (!fs.existsSync(filename)) continue;
    if (!fs.lstatSync(filename).isFile()) throw new Error(`Expected a regular file: ${filename}`);
    const original = fs.readFileSync(filename, 'utf8');
    const value = JSON.parse(original);
    const formatted = renderWorkflow(value, original);
    assert.deepEqual(JSON.parse(formatted), value, `Formatting changed content: ${filename}`);
    inspected++;
    if (formatted !== original) changes.push({ filename, original, formatted });
}
for (const { filename, original, formatted } of changes) {
    if (!check) {
        assert.equal(fs.readFileSync(filename, 'utf8'), original, `File changed during formatting: ${filename}`);
        fs.writeFileSync(filename, formatted);
        assert.equal(fs.readFileSync(filename, 'utf8'), formatted);
    }
    console.log(`${check ? 'Needs formatting' : 'Formatted'}: ${path.relative(root, filename)}`);
}
console.log(`Inspected ${inspected} workflows; ${changes.length} ${check ? 'need formatting' : 'formatted'}.`);
if (check && changes.length) process.exitCode = 1;
