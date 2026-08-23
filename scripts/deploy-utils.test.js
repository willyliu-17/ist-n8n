const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    buildWorkflowIdMap,
    assertUniqueRequestedWorkflowNames,
    remapExecuteWorkflowNodes,
    createWorkflowPayload,
    parseCreatedWorkflowId
} = require('./deploy-utils');
const { deployWorkflows } = require('./deploy');

function createTempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-utils-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeWorkflow(filePath, name) {
    fs.writeFileSync(filePath, JSON.stringify({
        id: `${name}-source-id`,
        name,
        nodes: [],
        connections: {},
        settings: {}
    }));
}

function response(data) {
    return {
        ok: true,
        json: async () => data
    };
}

function noFetchOptions(onFetch) {
    return {
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        fetchImpl: async () => {
            onFetch();
            throw new Error('fetch must not be called');
        }
    };
}

test('buildWorkflowIdMap creates an exact-name map', () => {
    const workflowIds = buildWorkflowIdMap([
        { id: 'target-a', name: 'Workflow A' },
        { id: 'target-b', name: 'workflow a' }
    ]);

    assert.equal(workflowIds.get('Workflow A'), 'target-a');
    assert.equal(workflowIds.get('workflow a'), 'target-b');
});

test('buildWorkflowIdMap rejects duplicate exact names', () => {
    assert.throws(
        () => buildWorkflowIdMap([
            { id: 'target-a', name: 'Workflow A' },
            { id: 'target-b', name: 'Workflow A' }
        ]),
        /duplicate workflows exactly named "Workflow A"/
    );
});

test('buildWorkflowIdMap ignores duplicate names outside the required set', () => {
    const workflowIds = buildWorkflowIdMap([
        { id: 'required-id', name: 'Required workflow' },
        { id: 'duplicate-a', name: 'Unrelated duplicate' },
        { id: 'duplicate-b', name: 'Unrelated duplicate' }
    ], new Set(['Required workflow']));

    assert.deepEqual([...workflowIds], [['Required workflow', 'required-id']]);
});

test('assertUniqueRequestedWorkflowNames rejects duplicate exact names only', () => {
    assert.doesNotThrow(() => assertUniqueRequestedWorkflowNames([
        { name: 'Workflow A' },
        { name: 'workflow a' }
    ]));
    assert.throws(
        () => assertUniqueRequestedWorkflowNames([
            { name: 'Workflow A' },
            { name: 'Workflow A' }
        ]),
        /duplicate requested workflows exactly named "Workflow A"/
    );
});

test('deployWorkflows rejects any missing requested path before fetch', async t => {
    const dir = createTempDir(t);
    const validPath = path.join(dir, 'valid.json');
    writeWorkflow(validPath, 'Valid workflow');
    let fetchCalls = 0;

    await assert.rejects(
        deployWorkflows(
            [validPath, path.join(dir, 'missing.json')],
            noFetchOptions(() => { fetchCalls += 1; })
        ),
        /File not found:/
    );
    assert.equal(fetchCalls, 0);
});

test('deployWorkflows rejects any build failure before fetch', async t => {
    const dir = createTempDir(t);
    const validPath = path.join(dir, 'valid.json');
    const invalidPath = path.join(dir, 'invalid.json');
    writeWorkflow(validPath, 'Valid workflow');
    fs.writeFileSync(invalidPath, '{ invalid json');
    let fetchCalls = 0;

    await assert.rejects(
        deployWorkflows(
            [validPath, invalidPath],
            noFetchOptions(() => { fetchCalls += 1; })
        ),
        /Error building workflow from/
    );
    assert.equal(fetchCalls, 0);
});

test('deployWorkflows rejects duplicate requested names before fetch', async t => {
    const dir = createTempDir(t);
    const firstPath = path.join(dir, 'first.json');
    const secondPath = path.join(dir, 'second.json');
    writeWorkflow(firstPath, 'Duplicate workflow');
    writeWorkflow(secondPath, 'Duplicate workflow');
    let fetchCalls = 0;

    await assert.rejects(
        deployWorkflows(
            [firstPath, secondPath],
            noFetchOptions(() => { fetchCalls += 1; })
        ),
        /duplicate requested workflows exactly named "Duplicate workflow"/
    );
    assert.equal(fetchCalls, 0);
});

test('deployWorkflows rejects an unknown cached name after GET and before POST', async t => {
    const dir = createTempDir(t);
    const workflowPath = path.join(dir, 'caller.json');
    fs.writeFileSync(workflowPath, JSON.stringify({
        id: 'caller-source-id',
        name: 'Caller',
        nodes: [{
            name: 'Call unknown',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: {
                workflowId: {
                    value: 'unknown-source-id',
                    cachedResultName: 'Unknown workflow'
                }
            }
        }],
        connections: {},
        settings: {}
    }));
    const methods = [];

    await assert.rejects(
        deployWorkflows([workflowPath], {
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            fetchImpl: async (_url, options = {}) => {
                methods.push(options.method || 'GET');
                return response({ data: [], nextCursor: null });
            }
        }),
        /references unknown workflow "Unknown workflow"/
    );
    assert.deepEqual(methods, ['GET']);
});

test('deployWorkflows rejects an unknown static ID after GET and before POST', async t => {
    const dir = createTempDir(t);
    const workflowPath = path.join(dir, 'caller.json');
    fs.writeFileSync(workflowPath, JSON.stringify({
        id: 'caller-source-id',
        name: 'Caller',
        nodes: [{
            name: 'Call unknown static ID',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: { workflowId: 'unknown-static-id' }
        }],
        connections: {},
        settings: {}
    }));
    const methods = [];

    await assert.rejects(
        deployWorkflows([workflowPath], {
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            fetchImpl: async (_url, options = {}) => {
                methods.push(options.method || 'GET');
                return response({ data: [], nextCursor: null });
            }
        }),
        /references unknown static workflow ID "unknown-static-id"/
    );
    assert.deepEqual(methods, ['GET']);
});

test('deployWorkflows rejects cached names that conflict with requested source IDs before POST', async t => {
    const dir = createTempDir(t);
    const callerPath = path.join(dir, 'caller.json');
    const childPath = path.join(dir, 'child.json');
    fs.writeFileSync(callerPath, JSON.stringify({
        id: 'caller-source-id',
        name: 'Caller',
        nodes: [{
            name: 'Call child as caller',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: {
                workflowId: {
                    value: 'child-source-id',
                    cachedResultName: 'Caller'
                }
            }
        }],
        connections: {},
        settings: {}
    }));
    fs.writeFileSync(childPath, JSON.stringify({
        id: 'child-source-id',
        name: 'Child',
        nodes: [],
        connections: {},
        settings: {}
    }));
    const methods = [];

    await assert.rejects(
        deployWorkflows([callerPath, childPath], {
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            fetchImpl: async (_url, options = {}) => {
                methods.push(options.method || 'GET');
                return response({ data: [], nextCursor: null });
            }
        }),
        /cached workflow name "Caller" but selector value resolves to "Child"/
    );
    assert.deepEqual(methods, ['GET']);
});

test('deployWorkflows rejects cached names that conflict with target IDs before POST', async t => {
    const dir = createTempDir(t);
    const workflowPath = path.join(dir, 'caller.json');
    fs.writeFileSync(workflowPath, JSON.stringify({
        id: 'caller-source-id',
        name: 'Caller',
        nodes: [{
            name: 'Call actual target as caller',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: {
                workflowId: {
                    value: 'actual-target-id',
                    cachedResultName: 'Caller'
                }
            }
        }],
        connections: {},
        settings: {}
    }));
    const methods = [];

    await assert.rejects(
        deployWorkflows([workflowPath], {
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            fetchImpl: async (_url, options = {}) => {
                methods.push(options.method || 'GET');
                return response({
                    data: [
                        { id: 'caller-target-id', name: 'Caller' },
                        { id: 'actual-target-id', name: 'Actual target' }
                    ],
                    nextCursor: null
                });
            }
        }),
        /cached workflow name "Caller" but selector value resolves to "Actual target"/
    );
    assert.deepEqual(methods, ['GET']);
});

test('deployWorkflows remaps an unknown cross-environment ID by its unique cached name', async t => {
    const dir = createTempDir(t);
    const workflowPath = path.join(dir, 'caller.json');
    fs.writeFileSync(workflowPath, JSON.stringify({
        id: 'caller-source-id',
        name: 'Caller',
        nodes: [{
            name: 'Call child',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: {
                workflowId: {
                    value: 'unknown-cross-environment-id',
                    cachedResultName: 'Child'
                }
            }
        }],
        connections: {},
        settings: {}
    }));
    const methods = [];
    let putPayload;

    await deployWorkflows([workflowPath], {
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        fetchImpl: async (_url, options = {}) => {
            const method = options.method || 'GET';
            methods.push(method);
            if (method === 'GET') {
                return response({
                    data: [
                        { id: 'caller-target-id', name: 'Caller' },
                        { id: 'child-target-id', name: 'Child' }
                    ],
                    nextCursor: null
                });
            }
            putPayload = JSON.parse(options.body);
            return response({});
        }
    });

    assert.deepEqual(methods, ['GET', 'PUT']);
    assert.equal(putPayload.nodes[0].parameters.workflowId.value, 'child-target-id');
    assert.equal(putPayload.nodes[0].parameters.workflowId.cachedResultUrl, '/workflow/child-target-id');
});

test('deployWorkflows ignores non-database Execute Workflow selectors', async t => {
    const dir = createTempDir(t);
    const workflowPath = path.join(dir, 'caller.json');
    const nodes = [
        {
            name: 'Parameter source',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: { source: 'parameter', workflowId: '' }
        },
        {
            name: 'Local file source',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: { source: 'localFile', workflowId: 42 }
        },
        {
            name: 'URL source',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: {
                source: 'url',
                workflowId: { value: 'unknown-id', cachedResultName: 'Unknown workflow' }
            }
        }
    ];
    fs.writeFileSync(workflowPath, JSON.stringify({
        id: 'caller-source-id',
        name: 'Caller',
        nodes,
        connections: {},
        settings: {}
    }));
    const methods = [];
    let putPayload;

    await deployWorkflows([workflowPath], {
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        fetchImpl: async (_url, options = {}) => {
            const method = options.method || 'GET';
            methods.push(method);
            if (method === 'GET') {
                return response({
                    data: [{ id: 'caller-target-id', name: 'Caller' }],
                    nextCursor: null
                });
            }
            putPayload = JSON.parse(options.body);
            return response({});
        }
    });

    assert.deepEqual(methods, ['GET', 'PUT']);
    assert.deepEqual(putPayload.nodes, nodes);
});

test('deployWorkflows rejects missing and invalid database selectors before POST', async t => {
    const cases = [
        { name: 'Missing selector', parameters: {} },
        { name: 'Empty string', parameters: { source: 'database', workflowId: '' } },
        { name: 'Non-string selector', parameters: { source: 'database', workflowId: 42 } },
        { name: 'Array selector', parameters: { source: 'database', workflowId: [] } },
        { name: 'Invalid object', parameters: { workflowId: { mode: 'list' } } }
    ];

    for (const testCase of cases) {
        const dir = createTempDir(t);
        const workflowPath = path.join(dir, 'caller.json');
        fs.writeFileSync(workflowPath, JSON.stringify({
            id: 'caller-source-id',
            name: 'Caller',
            nodes: [{
                name: testCase.name,
                type: 'n8n-nodes-base.executeWorkflow',
                parameters: testCase.parameters
            }],
            connections: {},
            settings: {}
        }));
        const methods = [];

        await assert.rejects(
            deployWorkflows([workflowPath], {
                apiUrl: 'https://unused.invalid',
                apiKey: 'test-key',
                fetchImpl: async (_url, options = {}) => {
                    methods.push(options.method || 'GET');
                    return response({
                        data: [{ id: 'caller-target-id', name: 'Caller' }],
                        nextCursor: null
                    });
                }
            }),
            /has an invalid database workflow selector/
        );
        assert.deepEqual(methods, ['GET']);
    }
});

test('deployWorkflows allows unrelated target duplicate names', async t => {
    const dir = createTempDir(t);
    const workflowPath = path.join(dir, 'workflow.json');
    writeWorkflow(workflowPath, 'Required workflow');
    const methods = [];

    await deployWorkflows([workflowPath], {
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        fetchImpl: async (_url, options = {}) => {
            const method = options.method || 'GET';
            methods.push(method);
            if (method === 'GET') {
                return response({
                    data: [
                        { id: 'required-target-id', name: 'Required workflow' },
                        { id: 'duplicate-a', name: 'Unrelated duplicate' },
                        { id: 'duplicate-b', name: 'Unrelated duplicate' }
                    ],
                    nextCursor: null
                });
            }
            return response({});
        }
    });
    assert.deepEqual(methods, ['GET', 'PUT']);
});

test('remapExecuteWorkflowNodes deep-clones nodes and updates matching selectors only', () => {
    const nodes = [
        {
            name: 'Call child',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: {
                workflowId: {
                    value: 'source-id',
                    cachedResultName: 'Child workflow',
                    cachedResultUrl: '/workflow/source-id'
                }
            }
        },
        {
            name: 'Unrelated node',
            type: 'n8n-nodes-base.set',
            parameters: {
                workflowId: {
                    value: 'unchanged',
                    cachedResultName: 'Child workflow',
                    cachedResultUrl: '/workflow/unchanged'
                }
            }
        },
        {
            name: 'Expression selector',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: { workflowId: '={{ $json.workflowId }}' }
        }
    ];

    const remapped = remapExecuteWorkflowNodes(nodes, new Map([['Child workflow', 'target-id']]));

    assert.notStrictEqual(remapped, nodes);
    assert.notStrictEqual(remapped[0], nodes[0]);
    assert.equal(remapped[0].parameters.workflowId.value, 'target-id');
    assert.equal(remapped[0].parameters.workflowId.cachedResultUrl, '/workflow/target-id');
    assert.equal(remapped[1].parameters.workflowId.value, 'unchanged');
    assert.equal(remapped[2].parameters.workflowId, '={{ $json.workflowId }}');
    assert.equal(nodes[0].parameters.workflowId.value, 'source-id');
    assert.equal(nodes[0].parameters.workflowId.cachedResultUrl, '/workflow/source-id');
});

test('static selectors remap requested source IDs and preserve target IDs and expressions', () => {
    const nodes = [
        {
            name: 'Plain source ID',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: { workflowId: 'child-source-id' }
        },
        {
            name: 'Object source ID',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: { workflowId: { value: 'child-source-id', mode: 'id' } }
        },
        {
            name: 'Target ID',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: { workflowId: 'existing-target-id' }
        },
        {
            name: 'Plain expression',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: { workflowId: '={{ $json.workflowId }}' }
        },
        {
            name: 'Object expression',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: { workflowId: { value: '={{ $json.workflowId }}', mode: 'id' } }
        }
    ];
    const remapped = remapExecuteWorkflowNodes(
        nodes,
        new Map([['Child workflow', 'child-target-id']]),
        new Map([['child-source-id', 'Child workflow']]),
        new Map([['existing-target-id', 'Existing workflow']])
    );

    assert.equal(remapped[0].parameters.workflowId, 'child-target-id');
    assert.equal(remapped[1].parameters.workflowId.value, 'child-target-id');
    assert.equal(remapped[1].parameters.workflowId.cachedResultUrl, '/workflow/child-target-id');
    assert.equal(remapped[2].parameters.workflowId, 'existing-target-id');
    assert.equal(remapped[3].parameters.workflowId, '={{ $json.workflowId }}');
    assert.deepEqual(remapped[4].parameters.workflowId, { value: '={{ $json.workflowId }}', mode: 'id' });
    assert.equal(nodes[0].parameters.workflowId, 'child-source-id');
});

test('static selectors fail closed for unknown IDs', () => {
    const nodes = [{
        name: 'Unknown static ID',
        type: 'n8n-nodes-base.executeWorkflow',
        parameters: { workflowId: 'unknown-id' }
    }];

    assert.throws(
        () => remapExecuteWorkflowNodes(nodes, new Map(), new Map(), new Map()),
        /references unknown static workflow ID "unknown-id"/
    );
});

test('static selectors fail closed when source and target ID authorities conflict', () => {
    const nodes = [{
        name: 'Ambiguous static ID',
        type: 'n8n-nodes-base.executeWorkflow',
        parameters: { workflowId: 'shared-id' }
    }];

    assert.throws(
        () => remapExecuteWorkflowNodes(
            nodes,
            new Map([['Requested workflow', 'requested-target-id']]),
            new Map([['shared-id', 'Requested workflow']]),
            new Map([['shared-id', 'Existing target workflow']])
        ),
        /selector value "shared-id" resolves to both "Requested workflow" and "Existing target workflow"/
    );
});

test('remapExecuteWorkflowNodes rejects an unresolved cached workflow name', () => {
    const nodes = [{
        name: 'Call missing child',
        type: 'n8n-nodes-base.executeWorkflow',
        parameters: {
            workflowId: {
                value: 'source-id',
                cachedResultName: 'Missing child'
            }
        }
    }];

    assert.throws(
        () => remapExecuteWorkflowNodes(nodes, new Map()),
        /references unknown workflow "Missing child"/
    );
    assert.equal(nodes[0].parameters.workflowId.value, 'source-id');
});

test('createWorkflowPayload preserves only deployable workflow fields', () => {
    const workflow = {
        id: 'source-id',
        name: 'Workflow A',
        nodes: [{ name: 'Source node' }],
        connections: { A: {} },
        settings: { executionOrder: 'v1' },
        active: true,
        tags: [{ id: 'tag-id' }]
    };
    const remappedNodes = [{ name: 'Remapped node' }];

    assert.deepEqual(createWorkflowPayload(workflow, remappedNodes), {
        name: 'Workflow A',
        nodes: remappedNodes,
        connections: { A: {} },
        settings: { executionOrder: 'v1' }
    });
});

test('parseCreatedWorkflowId returns an ID and rejects a missing ID', () => {
    assert.equal(parseCreatedWorkflowId({ id: 'created-id' }), 'created-id');
    assert.throws(() => parseCreatedWorkflowId({ name: 'Workflow A' }), /missing an ID/);
});
