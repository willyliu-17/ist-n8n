const test = require('node:test');
const assert = require('node:assert/strict');
const { deployConsistentWorkflows } = require('./deploy-consistency');

function source(name = 'Flow') {
    return { id: `local-${name}`, name, description: 'Shared description', active: true, nodes: [{ id: 'node', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} }], connections: {}, settings: {}, tags: [{ name: 'shared' }] };
}

function server(workflows, hook = () => {}) {
    const records = new Map(workflows.map(w => [w.id, structuredClone(w)]));
    const calls = [];
    let version = 10;
    const fetchImpl = async (url, options = {}) => {
        const method = options.method || 'GET';
        const endpoint = new URL(url).pathname.replace('/api/v1/', '');
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ method, endpoint, body });
        let value;
        const [, id, action] = endpoint.split('/');
        if (endpoint === 'workflows' && method === 'GET') value = { data: [...records.values()], nextCursor: null };
        else if (endpoint === 'tags') value = { data: [{ id: 'tag', name: 'shared' }], nextCursor: null };
        else if (endpoint === 'workflows' && method === 'POST') {
            value = { ...body, id: `created-${records.size}`, active: false, versionId: `v${version++}`, tags: [] };
            records.set(value.id, value);
        } else {
            const record = records.get(id);
            if (!record) throw new Error(`Unexpected endpoint ${endpoint}`);
            if (method === 'PUT' && !action) Object.assign(record, body, { versionId: `v${version++}` });
            if (method === 'PUT' && action === 'tags') record.tags = body.map(() => ({ id: 'tag', name: 'shared' }));
            if (method === 'POST' && action === 'activate') { record.active = true; record.activeVersionId = body.versionId; }
            if (method === 'POST' && action === 'deactivate') { record.active = false; record.activeVersionId = null; }
            value = record;
        }
        hook({ method, endpoint, body, records, value, calls });
        return { ok: true, json: async () => structuredClone(value) };
    };
    return { records, calls, fetchImpl };
}

function options(mock, extra = {}) { return { apiUrl: 'https://test.invalid', apiKey: 'test', fetchImpl: mock.fetchImpl, ...extra }; }

test('dry-run previews description, tags and active without mutations', async () => {
    const workflow = source();
    const mock = server([{ ...workflow, id: 'remote', description: '', active: false, tags: [], versionId: 'v1' }]);
    const result = await deployConsistentWorkflows([workflow], options(mock, { dryRun: true }));
    assert.ok(result.workflows[0].contentChanges.includes('description'));
    assert.equal(result.workflows[0].activeAfter, true);
    assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('all definitions saved before publication; active draft is republished and verified', async () => {
    const one = source('One');
    const two = source('Two');
    const mock = server([one, two].map(w => ({ ...w, id: `remote-${w.name}`, description: '', versionId: 'v1', activeVersionId: 'v1' })));
    const result = await deployConsistentWorkflows([one, two], options(mock));
    const firstPublish = mock.calls.findIndex(call => call.endpoint.endsWith('/activate'));
    assert.equal(mock.calls.slice(0, firstPublish).filter(call => call.method === 'PUT').length, 2);
    for (const record of mock.records.values()) {
        assert.equal(record.description, 'Shared description');
        assert.equal(record.activeVersionId, record.versionId);
    }
    assert.equal(result.completed.filter(item => item.phase === 'verified').length, 2);
    const callsBefore = mock.calls.length;
    await deployConsistentWorkflows([one, two], options(mock));
    assert.ok(mock.calls.slice(callsBefore).every(call => call.method === 'GET'));
});

test('deactivation and clearing description are persisted', async () => {
    const workflow = { ...source(), active: false, description: null, tags: [] };
    const mock = server([{ ...source(), id: 'remote', versionId: 'v1', activeVersionId: 'v1' }]);
    await deployConsistentWorkflows([workflow], options(mock));
    assert.equal(mock.records.get('remote').active, false);
    assert.equal(mock.records.get('remote').description, '');
    assert.deepEqual(mock.records.get('remote').tags, []);
});

test('failed content read-back prevents all publications and exposes partial progress', async () => {
    const one = source('One');
    const two = source('Two');
    const mock = server([one, two].map(w => ({ ...w, id: `remote-${w.name}`, description: '', versionId: 'v1', active: false })), ({ method, endpoint, value }) => {
        if (method === 'PUT' && endpoint.endsWith('remote-Two')) value.description = 'not saved';
    });
    await assert.rejects(deployConsistentWorkflows([one, two], options(mock)), error => {
        assert.match(error.message, /read-back mismatch/);
        assert.deepEqual(error.completed, [{ name: 'One', phase: 'content' }]);
        return true;
    });
    assert.equal(mock.calls.some(call => call.endpoint.endsWith('/activate')), false);
});

test('published version mismatch is not accepted as success even when active is true', async () => {
    const workflow = source();
    const mock = server([{ ...workflow, id: 'remote', active: false, versionId: 'v1' }], ({ endpoint, value }) => {
        if (endpoint.endsWith('/activate')) value.activeVersionId = 'wrong';
    });
    await assert.rejects(deployConsistentWorkflows([workflow], options(mock)), /Final state read-back mismatch/);
});

test('missing workflows are created inert and only published after final content writes', async () => {
    const workflow = source();
    const mock = server([]);
    await deployConsistentWorkflows([workflow], options(mock));
    const creation = mock.calls.find(call => call.method === 'POST' && call.endpoint === 'workflows');
    assert.deepEqual(creation.body.nodes, []);
    assert.equal('active' in creation.body, false);
    assert.equal([...mock.records.values()][0].active, true);
});

test('unsupported shared fields and missing tag identities fail before writes', async () => {
    const workflow = source();
    const mock = server([]);
    await assert.rejects(deployConsistentWorkflows([{ ...workflow, unknownSetting: true }], options(mock)), /Unsupported shared/);
    assert.equal(mock.calls.length, 0);
    await assert.rejects(deployConsistentWorkflows([{ ...workflow, tags: [{ name: 'not provisioned' }] }], options(mock)), /tag must be provisioned/);
    assert.ok(mock.calls.every(call => call.method === 'GET'));
});
