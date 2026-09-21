const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { selectWorkflowVersion, resolveSourceVersion, syncWorkflows } = require('./sync');

function source(id = 'remote') {
    return {
        id, name: `Flow ${id}`, description: 'Current description', active: true,
        settings: { timezone: 'Asia/Taipei' }, tags: [{ name: 'current' }],
        nodes: [{ id: 'draft', name: 'Draft', type: 'n8n-nodes-base.noOp', parameters: {} }],
        connections: {}, nodeGroups: [{ id: 'draft-group' }], activeVersionId: 'published-version',
        activeVersion: {
            workflowId: id, versionId: 'published-version', name: 'Historical name',
            nodes: [{ id: 'published', name: 'Published', type: 'n8n-nodes-base.noOp', parameters: {} }],
            connections: {}, nodeGroups: [{ id: 'published-group' }]
        }
    };
}

test('selects published graph without draft groups or historical workflow metadata', () => {
    const workflow = source();
    const selected = selectWorkflowVersion(workflow, 'published');
    assert.deepEqual(selected.nodes, workflow.activeVersion.nodes);
    assert.deepEqual(selected.nodeGroups, workflow.activeVersion.nodeGroups);
    for (const key of ['name', 'description', 'active', 'settings', 'tags']) assert.deepEqual(selected[key], workflow[key]);
    assert.equal(selectWorkflowVersion(workflow, 'draft'), workflow);
    delete workflow.activeVersion.nodeGroups;
    assert.deepEqual(selectWorkflowVersion(workflow, 'published').nodeGroups, []);
    assert.equal(workflow.nodes[0].name, 'Draft');
});

test('published selection rejects missing, mismatched and malformed snapshots', () => {
    for (const change of [
        w => { delete w.activeVersion; },
        w => { delete w.activeVersionId; },
        w => { w.activeVersion.versionId = 'wrong'; },
        w => { w.activeVersion.workflowId = 'wrong'; },
        w => { w.activeVersion.nodes = null; },
        w => { w.activeVersion.connections = []; }
    ]) {
        const workflow = source();
        change(workflow);
        assert.throws(() => selectWorkflowVersion(workflow, 'published'), /Verified published definition unavailable/);
    }
});

test('source version is explicit outside interactive CLI and prompts without a default', async () => {
    await assert.rejects(resolveSourceVersion(), /Explicit --source-version/);
    await assert.rejects(resolveSourceVersion('invalid'), /Invalid source version/);
    assert.equal(await resolveSourceVersion(undefined, { interactive: true, ask: async () => 'published' }), 'published');
    await assert.rejects(resolveSourceVersion(undefined, { interactive: true, ask: async () => '' }), /Invalid source version/);
    let called = false;
    await assert.rejects(syncWorkflows({ fetchImpl: async () => { called = true; } }), /Explicit --source-version/);
    assert.equal(called, false);
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'sync.js')], { encoding: 'utf8', env: {} });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Explicit --source-version/);
});

test('published sync validates every selected snapshot before writing any workflow', async t => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-version-'));
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', rootDir]);
    const sources = [source('one'), source('two')];
    delete sources[1].activeVersion;
    const fetchImpl = async url => ({ ok: true, json: async () => structuredClone(
        url.includes('?') ? { data: sources } : sources.find(w => url.endsWith('/' + w.id))
    ) });
    const options = { rootDir, apiUrl: 'https://test.invalid', apiKey: 'test', fetchImpl, sourceVersion: 'published' };
    await assert.rejects(syncWorkflows(options), /Verified published definition unavailable/);
    assert.equal(fs.existsSync(path.join(rootDir, 'workflows')), false);
    sources[1] = source('two');
    const results = await syncWorkflows(options);
    assert.equal(results.length, 2);
    assert.ok(results.every(r => r.sourceVersion === 'published'));
    assert.ok(results.every(r => r.sourceVersionId === 'published-version'));
    const stored = JSON.parse(fs.readFileSync(path.join(rootDir, 'workflows/flow_one_one/workflow.json'), 'utf8'));
    assert.equal(stored.nodes[0].name, 'Published');
    assert.deepEqual(stored.nodeGroups, [{ id: 'published-group' }]);
});

test('bulk published sync skips unpublished workflows without touching their local drafts', async t => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-version-'));
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', rootDir]);
    const unpublished = source('unpublished');
    unpublished.active = false;
    unpublished.activeVersionId = null;
    unpublished.activeVersion = null;
    const sources = [source('published'), unpublished];
    const fetchImpl = async url => ({ ok: true, json: async () => structuredClone(
        url.includes('?') ? { data: sources } : sources.find(w => url.endsWith('/' + w.id))
    ) });
    const options = { rootDir, apiUrl: 'https://test.invalid', apiKey: 'test', fetchImpl, sourceVersion: 'published' };
    const skipped = { name: unpublished.name, sourceVersion: 'published', skipped: true, reason: 'No published version', changed: 0 };
    const preview = await syncWorkflows({ ...options, dryRun: true });
    assert.deepEqual(preview.find(r => r.skipped), skipped);
    assert.equal(fs.existsSync(path.join(rootDir, 'workflows')), false);
    const results = await syncWorkflows(options);
    assert.deepEqual(results.find(r => r.skipped), skipped);
    assert.equal(results.filter(r => !r.skipped).length, 1);
    const unpublishedDir = path.join(rootDir, 'workflows/flow_unpublished_unpublished');
    assert.equal(fs.existsSync(unpublishedDir), false);
    const stored = JSON.parse(fs.readFileSync(path.join(rootDir, 'workflows/flow_published_published/workflow.json'), 'utf8'));
    assert.equal(stored.nodes[0].name, 'Published');

    fs.mkdirSync(unpublishedDir);
    const filename = path.join(unpublishedDir, 'workflow.json');
    const localText = JSON.stringify(unpublished, null, 2);
    fs.writeFileSync(filename, localText);
    sources.shift();
    assert.deepEqual(await syncWorkflows(options), [skipped]);
    assert.equal(fs.readFileSync(filename, 'utf8'), localText);
    for (const target of [unpublished.name, unpublishedDir]) {
        await assert.rejects(syncWorkflows({ ...options, targets: [target] }), /activeVersionId missing; activeVersion missing/);
    }
    const draft = await syncWorkflows({ ...options, sourceVersion: 'draft', dryRun: true });
    assert.equal(draft.length, 1);
    assert.equal(draft[0].skipped, undefined);
});

test('bulk published sync rejects inconsistent snapshots before writing even with skipped workflows', async t => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-version-'));
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', rootDir]);
    const unpublished = source('unpublished');
    delete unpublished.activeVersionId;
    delete unpublished.activeVersion;
    const sources = [unpublished, source('valid'), source('invalid')];
    const fetchImpl = async url => ({ ok: true, json: async () => structuredClone(
        url.includes('?') ? { data: sources } : sources.find(w => url.endsWith('/' + w.id))
    ) });
    for (const [change, expected] of [
        [w => { delete w.activeVersion; }, /activeVersion missing/],
        [w => { delete w.activeVersionId; }, /activeVersionId missing/],
        [w => { w.activeVersion.versionId = 'wrong'; }, /activeVersion.versionId mismatch/],
        [w => { w.activeVersion.workflowId = 'wrong'; }, /activeVersion.workflowId mismatch/],
        [w => { w.activeVersion.nodes = null; }, /activeVersion.nodes invalid/],
        [w => { w.activeVersion.connections = []; }, /activeVersion.connections invalid/]
    ]) {
        sources[2] = source('invalid');
        change(sources[2]);
        await assert.rejects(syncWorkflows({ rootDir, apiUrl: 'https://test.invalid', apiKey: 'test', fetchImpl, sourceVersion: 'published' }), expected);
        assert.equal(fs.existsSync(path.join(rootDir, 'workflows')), false);
    }
});
