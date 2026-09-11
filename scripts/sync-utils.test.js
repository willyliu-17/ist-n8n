const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApi } = require('./n8n-api');
const { createSyncContext, normalizeWorkflow, comparableWorkflow, unpackWorkflow, resolveReferences, EXTERNAL, safeExternalPath } = require('./sync-utils');
const { renderWorkflow, applyFilePlan } = require('./sync-files');
const { planSync } = require('./sync');
const { syncWorkflows } = require('./sync');
const { execFileSync } = require('node:child_process');
const { remapDataTableReferences, remapExecuteWorkflowNodes, remapCredentialReferences, injectDeploymentValues } = require('./deploy-utils');

function fixture() {
    const child = { id: 'child-local', name: 'Child', nodes: [], connections: {}, settings: {} };
    const local = {
        id: 'local', name: 'Caller', description: 'Shared description', active: true,
        nodes: [
            { id: 'node1', name: 'Code', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return [];' } },
            { id: 'node2', name: 'Call', type: 'n8n-nodes-base.executeWorkflow', parameters: { workflowId: { __rl: true, mode: 'list', value: child.id, cachedResultName: child.name, cachedResultUrl: `/workflow/${child.id}` } } },
            { id: 'node3', name: 'Table', type: 'n8n-nodes-base.dataTable', parameters: { dataTableId: { __rl: true, mode: 'name', value: 'stt_jobs_v3' } } },
            { id: 'node4', name: 'Callback', type: 'n8n-nodes-base.set', parameters: { jsonOutput: '__DEPLOY_STT_CALLBACK_URL__' }, credentials: { httpHeaderAuth: { id: 'cred-local', name: 'Header' } } }
        ],
        connections: {}, settings: { errorWorkflow: child.id }
    };
    const callbackUrl = 'https://example.invalid/webhook/stt-callback-v3';
    const source = injectDeploymentValues(local, { sttCallbackUrl: callbackUrl });
    source.id = 'remote';
    source.nodes = remapDataTableReferences(source.nodes, new Map(require('./stt-summary-v3-inventory').V3_DATA_TABLE_NAMES.map(name => [name, name === 'stt_jobs_v3' ? 'table-remote' : `table-${name}`])));
    source.nodes = remapExecuteWorkflowNodes(source.nodes, new Map([['Child', 'child-remote']]), new Map([[child.id, child.name]]));
    source.nodes = remapCredentialReferences(source.nodes, new Map([['httpHeaderAuth\u0000Header', 'cred-remote']]));
    source.settings.errorWorkflow = 'child-remote';
    const tables = [{ id: 'table-remote', name: 'stt_jobs_v3' }, { id: 'table-other', name: 'stt_summaries_v3' }];
    const sources = [source, { ...child, id: 'child-remote' }];
    const context = createSyncContext({ localWorkflows: [local, child], sourceWorkflows: sources, tables, callbackUrl });
    return { local, source, context };
}

test('deployment and normalization round-trip retains shared state and remaps identities', () => {
    const { local, source, context } = fixture();
    source.activeVersion = { nodes: ['runtime'] };
    source.updatedAt = 'runtime';
    source.nodes[0].id = 'regenerated-node';
    assert.deepEqual(comparableWorkflow(normalizeWorkflow(source, local, context)), comparableWorkflow(local));
    assert.equal(source.id, 'remote');
});

test('real changes to code, active, description, settings, and table selection survive', () => {
    const { local, source, context } = fixture();
    source.active = false;
    source.description = 'Changed';
    source.settings.timezone = 'Asia/Taipei';
    source.nodes[0].parameters.jsCode = 'return [{json:{changed:true}}];';
    source.nodes[2].parameters.dataTableId.value = 'table-other';
    const result = normalizeWorkflow(source, local, context);
    assert.equal(result.active, false);
    assert.equal(result.description, 'Changed');
    assert.equal(result.settings.timezone, 'Asia/Taipei');
    assert.equal(result.nodes[0].parameters.jsCode, source.nodes[0].parameters.jsCode);
    assert.equal(result.nodes[2].parameters.dataTableId.value, 'stt_summaries_v3');
});

test('unknown tables, contradictory selectors, and changed callback fail closed', () => {
    for (const change of [
        s => { s.nodes[2].parameters.dataTableId.value = 'unknown'; },
        s => { s.nodes[1].parameters.workflowId.cachedResultName = 'Wrong'; },
        s => { s.nodes[3].parameters.jsonOutput = 'https://wrong.invalid/webhook/stt-callback-v3'; }
    ]) {
        const { local, source, context } = fixture();
        change(source);
        assert.throws(() => normalizeWorkflow(source, local, context), /Unresolved|contradictory|Callback/);
    }
});

test('shared source stays shared unless one node actually changes', () => {
    const baseline = { nodes: ['One', 'Two'].map((name, i) => ({ id: String(i), name, type: 'n8n-nodes-base.code', parameters: { jsCode: EXTERNAL + 'nodes/Shared/jsCode.js' } })) };
    const read = relative => { assert.equal(relative, 'nodes/Shared/jsCode.js'); return 'return [];'; };
    const source = resolveReferences(baseline, read);
    const same = unpackWorkflow(source, baseline, read);
    assert.equal(same.files.size, 1);
    assert.deepEqual(same.workflow, baseline);
    source.nodes[1].parameters.jsCode = 'return [{json:{changed:true}}];';
    const split = unpackWorkflow(source, baseline, read);
    assert.equal(split.files.get('nodes/Shared/jsCode.js'), 'return [];');
    assert.notEqual(split.workflow.nodes[0].parameters.jsCode, split.workflow.nodes[1].parameters.jsCode);
    assert.deepEqual(resolveReferences(split.workflow, relative => split.files.get(relative)), source);
});

test('JSON renderer preserves unchanged compact subtrees and returns valid JSON', () => {
    const original = '{\n  "name": "Old",\n  "connections": {"A":{"main":[[]]}}\n}\n';
    const next = { ...JSON.parse(original), name: 'New', active: true };
    const rendered = renderWorkflow(next, original);
    assert.deepEqual(JSON.parse(rendered), next);
    assert.ok(rendered.includes('"connections": {"A":{"main":[[]]}}'));
    assert.equal(renderWorkflow(JSON.parse(original), original), original);
});

test('semantic no-op sync creates no file plan despite metadata and JSON key order', () => {
    const { local, source, context } = fixture();
    const record = { workflow: local, raw: local, text: JSON.stringify(local), read: () => assert.fail('No extraction needed') };
    const first = planSync(source, record, context);
    assert.equal(first.files.size, 0);
    assert.deepEqual(first.differences, []);
});

test('file plan rolls back completed writes when a later write fails', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'existing'), 'before');
    assert.throws(() => applyFilePlan(dir, new Map([['existing', 'after'], ['new', 'new'], ['fail', 'fail']]), {
        beforeWrite: relative => { if (relative === 'fail') throw new Error('Injected failure'); }
    }), /Injected failure/);
    assert.equal(fs.readFileSync(path.join(dir, 'existing'), 'utf8'), 'before');
    assert.equal(fs.existsSync(path.join(dir, 'new')), false);
    assert.equal(applyFilePlan(dir, new Map([['existing', 'before']])).changed, 0);
});

test('external files cannot escape or follow symlinks', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-path-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.throws(() => safeExternalPath(dir, '../outside'), /escapes/);
    fs.symlinkSync(os.tmpdir(), path.join(dir, 'linked'));
    assert.throws(() => safeExternalPath(dir, 'linked/file'), /symlink/);
});

test('API pagination follows every cursor and rejects loops and errors without leaking bodies', async () => {
    const calls = [];
    const api = createApi({ apiUrl: 'https://test.invalid', apiKey: 'test', fetchImpl: async url => {
        calls.push(url);
        return { ok: true, json: async () => calls.length === 1 ? { data: [{ id: '1' }], nextCursor: 'next' } : { data: [{ id: '2' }], nextCursor: null } };
    } });
    assert.deepEqual(await api.list('workflows'), [{ id: '1' }, { id: '2' }]);
    assert.match(calls[1], /cursor=next/);
    const loop = createApi({ apiUrl: 'https://test.invalid', apiKey: 'test', fetchImpl: async () => ({ ok: true, json: async () => ({ data: [], nextCursor: 'loop' }) }) });
    await assert.rejects(loop.list('workflows'), /repeated/);
    const fail = createApi({ apiUrl: 'https://test.invalid', apiKey: 'test', fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'secret' }) });
    await assert.rejects(fail.list('data-tables'), error => /HTTP 403/.test(error.message) && !error.message.includes('secret'));
});

test('new workflow sync is repeatable and refuses to overwrite a dirty real change', async t => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-integration-'));
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', rootDir]);
    const workflow = { id: 'remote', name: 'New Flow', active: false, nodes: [{ id: 'code', name: 'Code', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return [];' } }], connections: {}, settings: {} };
    const fetchImpl = async url => ({ ok: true, json: async () => structuredClone(url.includes('?') ? { data: [workflow] } : workflow) });
    const options = { rootDir, apiUrl: 'https://test.invalid', apiKey: 'test', fetchImpl };
    assert.ok((await syncWorkflows(options))[0].changed > 0);
    assert.equal((await syncWorkflows(options))[0].changed, 0);
    workflow.nodes[0].parameters.jsCode = 'return [{json:{changed:true}}];';
    const codePath = path.join(rootDir, 'workflows/new_flow_remote/nodes/Code/jsCode.js');
    const before = fs.readFileSync(codePath, 'utf8');
    const preview = await syncWorkflows({ ...options, dryRun: true });
    assert.ok(preview[0].differences.length > 0);
    assert.equal(fs.readFileSync(codePath, 'utf8'), before);
    await assert.rejects(syncWorkflows(options), /Local changes would be overwritten/);
    assert.equal(fs.readFileSync(codePath, 'utf8'), before);
});

test('conflicting node IDs and case-colliding baseline paths are rejected', () => {
    const { local, source, context } = fixture();
    source.nodes[0].name = source.nodes[1].name;
    source.nodes[1].name = 'Renamed';
    assert.throws(() => normalizeWorkflow(source, local, context), /Ambiguous node/);
    const baseline = { nodes: [
        { id: '1', name: 'One', type: 'n8n-nodes-base.code', parameters: { jsCode: EXTERNAL + 'nodes/A/code.js' } },
        { id: '2', name: 'Two', type: 'n8n-nodes-base.code', parameters: { jsCode: EXTERNAL + 'nodes/a/code.js' } }
    ] };
    assert.throws(() => unpackWorkflow(resolveReferences(baseline, () => 'return [];'), baseline, () => 'return [];'), /collision/);
});

test('only verified version-specific defaults compare equal and execution changes stay visible', () => {
    const baseline = { nodes: [{ id: 'code', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { mode: 'runOnceForAllItems', jsCode: 'return [];' } }] };
    const source = structuredClone(baseline);
    delete source.nodes[0].parameters.mode;
    assert.deepEqual(comparableWorkflow(source), comparableWorkflow(baseline));
    source.nodes[0].parameters.mode = 'runOnceForEachItem';
    assert.notDeepEqual(comparableWorkflow(source), comparableWorkflow(baseline));
    source.nodes[0].typeVersion = baseline.nodes[0].typeVersion = 99;
    delete source.nodes[0].parameters.mode;
    assert.notDeepEqual(comparableWorkflow(source), comparableWorkflow(baseline));
});

test('raw JSON export remains repeatable and does not create extracted node files', async t => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-raw-'));
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', rootDir]);
    const workflow = { id: 'raw', name: 'Raw', active: false, nodes: [{ id: 'code', name: 'Code', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return [];' } }], connections: {}, settings: {} };
    const fetchImpl = async url => ({ ok: true, json: async () => structuredClone(url.includes('?') ? { data: [workflow] } : workflow) });
    const options = { rootDir, apiUrl: 'https://test.invalid', apiKey: 'test', noUnpack: true, fetchImpl };
    await syncWorkflows(options);
    const saved = JSON.parse(fs.readFileSync(path.join(rootDir, 'workflows/raw_raw.json'), 'utf8'));
    assert.equal(saved.nodes[0].parameters.jsCode, 'return [];');
    assert.equal(fs.existsSync(path.join(rootDir, 'workflows/raw_raw/nodes')), false);
    assert.equal((await syncWorkflows(options))[0].changed, 0);
});

test('a missing V3 directory is created with its canonical inventory identity', async t => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-v3-new-'));
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', rootDir]);
    const workflow = { id: 'remote', name: 'IST bot Slack ingress v3', active: false, nodes: [], connections: {}, settings: {} };
    const fetchImpl = async url => ({ ok: true, json: async () => structuredClone(url.includes('?') ? { data: [workflow] } : workflow) });
    const options = { rootDir, apiUrl: 'https://test.invalid', apiKey: 'test', fetchImpl };
    await syncWorkflows(options);
    const filename = path.join(rootDir, 'workflows/ist_bot_slack_ingress_v3_IstBotSlackIngressV3A1/workflow.json');
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).id, 'IstBotSlackIngressV3A1');
    assert.equal((await syncWorkflows(options))[0].changed, 0);
});
