const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
    buildWorkflowIdMap,
    assertUniqueRequestedWorkflowNames,
    collectCredentialReferences,
    buildCredentialReferenceMap,
    remapCredentialReferences,
    collectDataTableReferences,
    remapDataTableReferences,
    preserveTargetDataTableIds,
    assertDataTableTargetIds,
    remapExecuteWorkflowNodes,
    injectDeploymentValues,
    createWorkflowPayload,
    parseCreatedWorkflowId
} = require('./deploy-utils');
const {
    deployWorkflows,
    provisionV3WorkflowInventory,
    inspectV3DataTableInventory,
    deployV3WorkflowInventory: deployV3WorkflowInventoryWithoutDefaults
} = require('./deploy');

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

function failedResponse(status = 500, body = 'mock failure') {
    return {
        ok: false,
        status,
        statusText: 'Mock Failure',
        text: async () => body
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

test('injectDeploymentValues replaces the STT callback placeholder without mutating source', () => {
    const workflow = {
        name: 'STT: dispatch attempt v3',
        nodes: [{
            name: 'Attach Callback URL',
            parameters: {
                assignments: {
                    assignments: [{
                        name: 'callbackUrl',
                        value: '__DEPLOY_STT_CALLBACK_URL__'
                    }]
                }
            }
        }]
    };

    const injected = injectDeploymentValues(workflow, {
        sttCallbackUrl: 'https://n8n.example/webhook/stt-callback-v3'
    });

    assert.equal(
        injected.nodes[0].parameters.assignments.assignments[0].value,
        'https://n8n.example/webhook/stt-callback-v3'
    );
    assert.equal(
        workflow.nodes[0].parameters.assignments.assignments[0].value,
        '__DEPLOY_STT_CALLBACK_URL__'
    );
});

test('injectDeploymentValues rejects missing or unsafe STT callback URLs', () => {
    const workflow = {
        name: 'STT: dispatch attempt v3',
        nodes: [{ parameters: { value: '__DEPLOY_STT_CALLBACK_URL__' } }]
    };

    assert.throws(() => injectDeploymentValues(workflow, {}), /STT_CALLBACK_URL is required/);
    for (const value of [
        'http://n8n.example/webhook/stt-callback-v3',
        'https://n8n.example/webhook/wrong',
        'https://n8n.example/webhook/stt-callback-v3?token=x',
        'https://user:pass@n8n.example/webhook/stt-callback-v3'
    ]) {
        assert.throws(
            () => injectDeploymentValues(workflow, { sttCallbackUrl: value }),
            /STT_CALLBACK_URL/
        );
    }
});

test('injectDeploymentValues leaves workflows without deployment placeholders unchanged', () => {
    const workflow = { name: 'Unrelated', nodes: [], connections: {}, settings: {} };
    assert.strictEqual(injectDeploymentValues(workflow, {}), workflow);
});

test('preserveTargetDataTableIds remaps source names by stable node identity', () => {
    const source = [{
        id: 'node-1',
        name: 'Read Jobs',
        type: 'n8n-nodes-base.dataTable',
        parameters: { dataTableId: { __rl: true, mode: 'name', value: 'stt_jobs_v3' } }
    }];
    const target = [{
        id: 'node-1',
        name: 'Read Jobs',
        type: 'n8n-nodes-base.dataTable',
        parameters: { dataTableId: { __rl: true, mode: 'id', value: 'target-table-id' } }
    }];

    const remapped = preserveTargetDataTableIds(source, target);
    assert.deepEqual(remapped[0].parameters.dataTableId, {
        __rl: true,
        mode: 'id',
        value: 'target-table-id'
    });
    assert.equal(source[0].parameters.dataTableId.mode, 'name');
});

test('preserveTargetDataTableIds fails closed without one matching target ID', () => {
    const source = [{
        id: 'node-1',
        name: 'Read Jobs',
        type: 'n8n-nodes-base.dataTable',
        parameters: { dataTableId: { __rl: true, mode: 'name', value: 'stt_jobs_v3' } }
    }];
    assert.throws(() => preserveTargetDataTableIds(source, []), /no unique target ID locator/);
});

test('deployWorkflows rejects a missing STT callback URL before network access', async t => {
    const dir = createTempDir(t);
    const workflowPath = path.join(dir, 'dispatcher.json');
    fs.writeFileSync(workflowPath, JSON.stringify({
        id: 'dispatcher-source-id',
        name: 'STT: dispatch attempt v3',
        nodes: [{ parameters: { value: '__DEPLOY_STT_CALLBACK_URL__' } }],
        connections: {},
        settings: {}
    }));
    let fetchCalls = 0;

    await assert.rejects(
        deployWorkflows([workflowPath], noFetchOptions(() => { fetchCalls += 1; })),
        /STT_CALLBACK_URL is required/
    );
    assert.equal(fetchCalls, 0);
});

test('deployWorkflows injects the validated STT callback URL into the PUT payload', async t => {
    const dir = createTempDir(t);
    const workflowPath = path.join(dir, 'dispatcher.json');
    fs.writeFileSync(workflowPath, JSON.stringify({
        id: 'dispatcher-source-id',
        name: 'STT: dispatch attempt v3',
        nodes: [{ parameters: { value: '__DEPLOY_STT_CALLBACK_URL__' } }],
        connections: {},
        settings: {}
    }));
    let putPayload;

    await deployWorkflows([workflowPath], {
        apiUrl: 'https://n8n.example',
        apiKey: 'test-key',
        sttCallbackUrl: 'https://n8n.example/webhook/stt-callback-v3',
        fetchImpl: async (_url, options = {}) => {
            if ((options.method || 'GET') === 'PUT') {
                putPayload = JSON.parse(options.body);
                return response({});
            }
            return response({
                data: [{ id: 'dispatcher-target-id', name: 'STT: dispatch attempt v3' }],
                nextCursor: null
            });
        }
    });

    assert.equal(
        putPayload.nodes[0].parameters.value,
        'https://n8n.example/webhook/stt-callback-v3'
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

test('createWorkflowPayload preserves only pinned public API workflow fields', () => {
    const workflow = {
        id: 'source-id',
        name: 'Workflow A',
        nodes: [{ name: 'Source node' }],
        connections: { A: {} },
        settings: { executionOrder: 'v1' },
        description: 'Workflow description',
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

function getV3Inventory() {
    return require('./stt-summary-v3-inventory').V3_WORKFLOW_INVENTORY;
}

function getV3DataTableNames() {
    return require('./stt-summary-v3-inventory').V3_DATA_TABLE_NAMES;
}

const P2_APPROVAL = Object.freeze({ approved: true, gate: 'P2', reference: 'P2-approval-001' });
const P3_EVIDENCE = Object.freeze({ approved: true, gate: 'P3', reference: 'P3-schema-001' });
const P4_APPROVAL = Object.freeze({ approved: true, gate: 'P4', reference: 'P4-approval-001' });
const CANONICAL_SCHEMA_PATH = path.resolve(
    __dirname,
    '..',
    'workflows/automation_provision_state_v3_AutomationProvV3A1/nodes/State_Schema/schema.json'
);

function dataTableIdMap() {
    return new Map([
        ['suspect_stt_candidates_v3', 'table-suspects'],
        ['stt_jobs_v3', 'table-jobs'],
        ['summary_requests_v3', 'table-summaries'],
        ['automation_errors_v3', 'table-errors']
    ]);
}

function canonicalDataTableSchema() {
    return JSON.parse(fs.readFileSync(CANONICAL_SCHEMA_PATH, 'utf8'));
}

function p3TargetTables() {
    return [...dataTableIdMap()].map(([name, id]) => ({ id, name }));
}

function containsMap(value) {
    if (value instanceof Map) return true;
    if (!value || typeof value !== 'object') return false;
    return Object.values(value).some(containsMap);
}

function canonicalSerializeForTest(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalSerializeForTest).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => (
            `${JSON.stringify(key)}:${canonicalSerializeForTest(value[key])}`
        )).join(',')}}`;
    }
    return JSON.stringify(value);
}

function recomputeArtifactDigest(artifact) {
    const unsigned = {
        version: artifact.version,
        gate: artifact.gate,
        approvalReference: artifact.approvalReference,
        canonicalSchemaDigest: artifact.canonicalSchemaDigest,
        tables: artifact.tables
    };
    artifact.artifactDigest = crypto
        .createHash('sha256')
        .update(canonicalSerializeForTest(unsigned))
        .digest('hex');
    return artifact;
}

function p4ApprovalFor(artifact, overrides = {}) {
    return {
        ...P4_APPROVAL,
        approvedP3ArtifactDigest: artifact.artifactDigest,
        ...overrides
    };
}

async function createP3Artifact(readback = table => ({
    ...table,
    columns: structuredClone(canonicalDataTableSchema()[table.name])
})) {
    const tables = p3TargetTables();
    return inspectV3DataTableInventory({
        approvalEvidence: P3_EVIDENCE,
        tables,
        readTableById: async id => readback(tables.find(table => table.id === id))
    });
}

let cachedP3Artifact;

async function deployV3WorkflowInventory(options) {
    cachedP3Artifact ||= JSON.parse(JSON.stringify(await createP3Artifact()));
    const approvalEvidence = options.approvalEvidence === P4_APPROVAL
        ? p4ApprovalFor(options.p3Artifact ?? cachedP3Artifact)
        : options.approvalEvidence;
    return deployV3WorkflowInventoryWithoutDefaults({
        ...options,
        approvalEvidence,
        p3Artifact: options.p3Artifact ?? cachedP3Artifact
    });
}

function workflowDetail(id, name, overrides = {}) {
    return {
        id,
        name,
        active: false,
        nodes: [],
        connections: {},
        settings: {},
        ...overrides
    };
}

function createInventorySourceTree(t, configure = () => ({})) {
    const rootDir = createTempDir(t);
    const inventory = getV3Inventory();

    for (const [name, relativePath] of inventory) {
        const directory = path.join(rootDir, relativePath);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'workflow.json'), JSON.stringify({
            id: `${name}-source-id`,
            name,
            nodes: [{ name: 'Source', type: 'n8n-nodes-base.noOp', parameters: {} }],
            connections: {},
            settings: {},
            ...configure(name)
        }));
    }

    return rootDir;
}

function createCredentialP4Fixture(t) {
    const inventory = getV3Inventory();
    const credentialWorkflowName = inventory[0][0];
    const rootDir = createInventorySourceTree(t, name => name === credentialWorkflowName ? {
        nodes: [{
            name: 'HTTP Request',
            type: 'n8n-nodes-base.httpRequest',
            parameters: {},
            credentials: { httpHeaderAuth: { id: 'source-id', name: 'Header Auth account 2' } }
        }]
    } : {});
    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    const donor = {
        id: 'credential-donor',
        name: 'Credential donor',
        nodes: [{ credentials: {
            httpHeaderAuth: { id: 'planned-credential-id', name: 'Header Auth account 2' }
        } }]
    };
    targets.push(donor);
    return {
        inventory,
        rootDir,
        targets,
        donor,
        ids: new Map(targets.slice(0, inventory.length).map(workflow => [workflow.name, workflow.id])),
        targetById: new Map(targets.map(workflow => [workflow.id, workflow]))
    };
}

test('exports the exact authoritative v3 workflow inventory in deployment order', () => {
    assert.deepEqual(getV3Inventory(), [
        ['Automation: provision state v3', 'workflows/automation_provision_state_v3_AutomationProvV3A1'],
        ['Stream Metadata: resolve by IDs v3', 'workflows/stream_metadata_resolve_by_ids_v3_StreamMetaV3A001'],
        ['STT: dispatch attempt v3', 'workflows/stt_dispatch_attempt_v3_STTDispatchV3A01'],
        ['STT: callback ingress v3', 'workflows/stt_callback_ingress_v3_STTCallbackV3A1'],
        ['STT result listener v3', 'workflows/stt_result_listener_v3_STTListenerV3A01'],
        ['Req STT process v3', 'workflows/req_stt_process_v3_ReqSTTProcessV3A'],
        ['Summary: orchestrate request v3', 'workflows/summary_orchestrate_request_v3_SummaryOrchV3A01'],
        ['AI SUMMARY v3', 'workflows/ai_summary_v3_AISummaryV3A0001'],
        ['Summary: coordinator v3', 'workflows/summary_coordinator_v3_SummaryCoordV3A1'],
        ['Automation: retry and repair v3', 'workflows/automation_retry_and_repair_v3_AutoRepairV3A001'],
        ['Automation: error handler v3', 'workflows/automation_error_handler_v3_AutomationErrorV3A1'],
        ['Query Steam Logs v3', 'workflows/query_steam_logs_v3_QueryLogsV3A0001'],
        ['Tencent realtime VDS v3', 'workflows/tencent_realtime_vds_v3_TencentVDSV3A001'],
        ['Collect suspect streamID v3', 'workflows/collect_suspect_streamid_v3_CollectSuspectV3'],
        ['IST bot entry v3', 'workflows/ist_bot_entry_v3_IstBotEntryV3A01'],
        ['IST bot Slack ingress v3', 'workflows/ist_bot_slack_ingress_v3_IstBotSlackIngressV3A1']
    ]);
    assert.ok(Object.isFrozen(getV3Inventory()));
    assert.ok(getV3Inventory().every(tuple => Object.isFrozen(tuple)));
});

test('exports the frozen exact authoritative v3 Data Table names', () => {
    assert.deepEqual(getV3DataTableNames(), [
        'suspect_stt_candidates_v3',
        'stt_jobs_v3',
        'summary_requests_v3',
        'automation_errors_v3'
    ]);
    assert.ok(Object.isFrozen(getV3DataTableNames()));
});

test('collectDataTableReferences accepts repeated four-table exact-name placeholders only', () => {
    const workflows = [{
        name: 'Data workflow',
        nodes: [
            ...getV3DataTableNames().map((tableName, index) => ({
                name: `Table ${index}`,
                type: 'n8n-nodes-base.dataTable',
                parameters: { dataTableId: { __rl: true, mode: 'name', value: tableName } }
            })),
            {
                name: 'Repeated jobs table',
                type: 'n8n-nodes-base.dataTable',
                parameters: {
                    dataTableId: { __rl: true, mode: 'name', value: 'stt_jobs_v3' }
                }
            },
            {
                name: 'Unrelated locator',
                type: 'n8n-nodes-base.set',
                parameters: { dataTableId: { mode: 'id', value: 'ignore-me' } }
            }
        ]
    }];

    assert.deepEqual(collectDataTableReferences(workflows), [
        { workflowName: 'Data workflow', nodeName: 'Table 0', tableName: 'suspect_stt_candidates_v3' },
        { workflowName: 'Data workflow', nodeName: 'Table 1', tableName: 'stt_jobs_v3' },
        { workflowName: 'Data workflow', nodeName: 'Table 2', tableName: 'summary_requests_v3' },
        { workflowName: 'Data workflow', nodeName: 'Table 3', tableName: 'automation_errors_v3' },
        { workflowName: 'Data workflow', nodeName: 'Repeated jobs table', tableName: 'stt_jobs_v3' }
    ]);
    assert.deepEqual(collectDataTableReferences([{ name: 'No tables', nodes: [] }]), []);
});

test('collectDataTableReferences fails closed for non-authoritative Data Table locators', () => {
    const cases = [
        { label: 'source ID', locator: { __rl: true, mode: 'id', value: 'source-table-id' } },
        { label: 'list mode', locator: { __rl: true, mode: 'list', value: 'stt_jobs_v3' } },
        { label: 'expression', locator: { __rl: true, mode: 'name', value: '={{ $json.table }}' } },
        { label: 'legacy name', locator: { __rl: true, mode: 'name', value: 'stt_jobs' } },
        { label: 'unknown name', locator: { __rl: true, mode: 'name', value: 'unknown_v3' } },
        {
            label: 'extra locator metadata',
            locator: { __rl: true, mode: 'name', value: 'stt_jobs_v3', cachedResultName: 'stt_jobs_v3' }
        },
        { label: 'missing locator', locator: undefined }
    ];

    for (const testCase of cases) {
        assert.throws(() => collectDataTableReferences([{
            name: 'Data workflow',
            nodes: [{
                name: testCase.label,
                type: 'n8n-nodes-base.dataTable',
                parameters: testCase.locator === undefined ? {} : { dataTableId: testCase.locator }
            }]
        }]), /invalid Data Table.*placeholder|authoritative Data Table/i, testCase.label);
    }
});

test('remapDataTableReferences deep-clones and emits the exact runtime ID locator shape', () => {
    const nodes = [{
        name: 'Jobs table',
        type: 'n8n-nodes-base.dataTable',
        parameters: {
            dataTableId: { __rl: true, mode: 'name', value: 'stt_jobs_v3' }
        }
    }];

    const remapped = remapDataTableReferences(nodes, dataTableIdMap());

    assert.notStrictEqual(remapped, nodes);
    assert.notStrictEqual(remapped[0], nodes[0]);
    assert.deepEqual(remapped[0].parameters.dataTableId, {
        __rl: true,
        mode: 'id',
        value: 'table-jobs'
    });
    assert.equal(nodes[0].parameters.dataTableId.mode, 'name');
});

test('assertDataTableTargetIds compares each deployed node identity and exact expected ID', () => {
    const expected = [
        {
            id: 'node-jobs',
            name: 'Jobs table',
            type: 'n8n-nodes-base.dataTable',
            parameters: { dataTableId: { __rl: true, mode: 'id', value: 'table-jobs' } }
        },
        {
            id: 'node-summaries',
            name: 'Summaries table',
            type: 'n8n-nodes-base.dataTable',
            parameters: { dataTableId: { __rl: true, mode: 'id', value: 'table-summaries' } }
        }
    ];
    const swapped = structuredClone(expected);
    swapped[0].parameters.dataTableId.value = 'table-summaries';
    swapped[1].parameters.dataTableId.value = 'table-jobs';

    assert.doesNotThrow(() => assertDataTableTargetIds(structuredClone(expected), expected));
    assert.throws(
        () => assertDataTableTargetIds(swapped, expected),
        /Jobs table.*expected.*table-jobs|exact expected Data Table target ID/i
    );
});

test('P3 requires independent approval before inspecting Data Table metadata', async () => {
    let readCalls = 0;

    await assert.rejects(inspectV3DataTableInventory({
        approvalEvidence: P4_APPROVAL,
        tables: [],
        readTableById: async () => {
            readCalls += 1;
        }
    }), /explicit P3.*evidence|approval/i);
    assert.equal(readCalls, 0);
});

test('P3 inspector accepts normalized metadata only and rejects unadapted API envelopes', async () => {
    const tables = p3TargetTables().map(table => ({ name: table.name, id: table.id }));
    const canonical = canonicalDataTableSchema();
    const sanitizedListEnvelope = {
        data: tables.map(table => ({ ...table, createdAt: 'redacted-fixture' }))
    };
    const normalizedTables = sanitizedListEnvelope.data.map(({ id, name }) => ({ name, id }));

    await assert.doesNotReject(inspectV3DataTableInventory({
        approvalEvidence: P3_EVIDENCE,
        tables: normalizedTables,
        readTableById: async id => {
            const table = normalizedTables.find(candidate => candidate.id === id);
            const sanitizedReadEnvelope = {
                data: { ...table, columns: structuredClone(canonical[table.name]), projectId: 'redacted-fixture' }
            };
            const { id: normalizedId, name, columns } = sanitizedReadEnvelope.data;
            return { columns, name, id: normalizedId };
        }
    }));
    await assert.rejects(inspectV3DataTableInventory({
        approvalEvidence: P3_EVIDENCE,
        tables: { data: tables },
        readTableById: async () => undefined
    }), /normalized.*metadata|must be.*array/i);
    await assert.rejects(inspectV3DataTableInventory({
        approvalEvidence: P3_EVIDENCE,
        tables,
        readTableById: async id => {
            const table = tables.find(candidate => candidate.id === id);
            return { data: { ...table, columns: canonical[table.name] } };
        }
    }), /normalized.*readback|metadata/i);
});

test('P3 builds one JSON-serializable deep-frozen schema-bound artifact and reads every ID back', async () => {
    const tables = p3TargetTables();
    const readIds = [];

    const artifact = await inspectV3DataTableInventory({
        approvalEvidence: P3_EVIDENCE,
        tables,
        readTableById: async id => {
            readIds.push(id);
            const table = tables.find(candidate => candidate.id === id);
            return {
                ...table,
                columns: structuredClone(canonicalDataTableSchema()[table.name])
            };
        }
    });

    assert.deepEqual(Object.keys(artifact), [
        'version',
        'gate',
        'approvalReference',
        'canonicalSchemaDigest',
        'tables',
        'artifactDigest'
    ]);
    assert.equal(artifact.version, 1);
    assert.equal(artifact.gate, 'P3');
    assert.equal(artifact.approvalReference, P3_EVIDENCE.reference);
    assert.match(artifact.canonicalSchemaDigest, /^[a-f0-9]{64}$/);
    assert.match(artifact.artifactDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(artifact.tables, tables.map(table => ({
        ...table,
        columns: canonicalDataTableSchema()[table.name]
    })));
    assert.deepEqual(readIds, [...dataTableIdMap().values()]);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(artifact)));
    assert.ok(Object.isFrozen(artifact));
    assert.ok(Object.isFrozen(artifact.tables));
    assert.ok(artifact.tables.every(table => Object.isFrozen(table) && Object.isFrozen(table.columns)));
    assert.ok(artifact.tables.every(table => table.columns.every(column => Object.isFrozen(column))));
    assert.equal(containsMap(artifact), false);
    assert.throws(() => Map.prototype.set.call(artifact, 'stt_jobs_v3', 'changed-id'), TypeError);
});

test('P3 resolves the canonical schema independently from the process working directory', async () => {
    const originalCwd = process.cwd();
    try {
        process.chdir(os.tmpdir());
        const artifact = await createP3Artifact();
        assert.deepEqual(artifact.tables.map(table => table.name), getV3DataTableNames());
    } finally {
        process.chdir(originalCwd);
    }
});

test('P3 fails closed for missing names, duplicate names, and duplicate target IDs', async () => {
    const validTables = [...dataTableIdMap()].map(([name, id]) => ({ id, name }));
    const cases = [
        { label: 'missing', tables: validTables.slice(0, -1), pattern: /missing.*automation_errors_v3/i },
        {
            label: 'duplicate name',
            tables: [...validTables, { id: 'duplicate-jobs', name: 'stt_jobs_v3' }],
            pattern: /multiple.*stt_jobs_v3|duplicate.*name/i
        },
        {
            label: 'duplicate target ID',
            tables: validTables.map(table => table.name === 'automation_errors_v3'
                ? { ...table, id: 'table-jobs' }
                : table),
            pattern: /target ID.*multiple|duplicate target ID/i
        }
    ];

    for (const testCase of cases) {
        await assert.rejects(inspectV3DataTableInventory({
            approvalEvidence: P3_EVIDENCE,
            tables: testCase.tables,
            readTableById: async id => {
                const table = testCase.tables.find(candidate => candidate.id === id);
                return table && {
                    ...table,
                    columns: structuredClone(canonicalDataTableSchema()[table.name])
                };
            }
        }), testCase.pattern, testCase.label);
    }
});

test('P3 fails closed when target ID readback has a different exact name', async () => {
    const tables = p3TargetTables();

    await assert.rejects(inspectV3DataTableInventory({
        approvalEvidence: P3_EVIDENCE,
        tables,
        readTableById: async id => {
            const table = tables.find(candidate => candidate.id === id);
            return {
                ...table,
                name: id === 'table-jobs' ? 'wrong_jobs_v3' : table.name,
                columns: structuredClone(canonicalDataTableSchema()[table.name])
            };
        }
    }), /table-jobs.*name|name.*mismatch/i);
});

test('P3 compares every readback custom column against canonical name, type, and order', async () => {
    const canonical = canonicalDataTableSchema();
    const cases = [
        {
            label: 'missing column',
            mutate: columns => columns.slice(0, -1),
            pattern: /missing|schema.*mismatch/i
        },
        {
            label: 'extra column',
            mutate: columns => [...columns, { name: 'extraColumn', type: 'string' }],
            pattern: /extra|schema.*mismatch/i
        },
        {
            label: 'duplicate column',
            mutate: columns => [...columns, { ...columns[0] }],
            pattern: /duplicate.*column/i
        },
        {
            label: 'wrong type',
            mutate: columns => columns.map((column, index) => index === 0
                ? { ...column, type: column.type === 'string' ? 'number' : 'string' }
                : column),
            pattern: /type|schema.*mismatch/i
        },
        {
            label: 'wrong order',
            mutate: columns => [columns[1], columns[0], ...columns.slice(2)],
            pattern: /order|schema.*mismatch/i
        },
        {
            label: 'system column collision',
            mutate: columns => [...columns, { name: 'createdAt', type: 'date' }],
            pattern: /system column.*collision/i
        }
    ];

    for (const testCase of cases) {
        await assert.rejects(createP3Artifact(table => ({
            ...table,
            columns: testCase.mutate(structuredClone(canonical[table.name]))
        })), testCase.pattern, testCase.label);
    }
});

test('collects unique credential reference metadata without credential values', () => {
    const refs = collectCredentialReferences([{ nodes: [
        { credentials: { httpHeaderAuth: { id: 'source-id', name: 'Header Auth account 2' } } },
        { credentials: { httpHeaderAuth: { id: 'source-id', name: 'Header Auth account 2' } } },
        { credentials: { slackApi: { id: 'slack-id', name: 'C0 Slack' } } }
    ] }]);

    assert.deepEqual(refs, [
        { type: 'httpHeaderAuth', name: 'Header Auth account 2', id: 'source-id' },
        { type: 'slackApi', name: 'C0 Slack', id: 'slack-id' }
    ]);
    assert.ok(refs.every(ref => Object.keys(ref).sort().join(',') === 'id,name,type'));
});

test('rejects invalid credential metadata before it can be mapped', () => {
    assert.throws(
        () => collectCredentialReferences([{ name: 'Caller', nodes: [{
            name: 'HTTP Request',
            credentials: { httpHeaderAuth: { id: 'source-id' } }
        }] }]),
        /invalid credential reference metadata/i
    );
});

test('rejects control characters and whitespace-only credential metadata', () => {
    const invalidReferences = [
        { type: ' ', name: 'Credential', id: 'id' },
        { type: 'httpHeaderAuth', name: '\t', id: 'id' },
        { type: 'httpHeaderAuth', name: 'Credential', id: '\n' },
        { type: 'http\u0000HeaderAuth', name: 'Credential', id: 'id' },
        { type: 'httpHeaderAuth', name: 'Credential\u001f', id: 'id' },
        { type: 'httpHeaderAuth', name: 'Credential', id: 'id\u007f' }
    ];

    for (const reference of invalidReferences) {
        assert.throws(() => collectCredentialReferences([{ nodes: [{
            credentials: { [reference.type]: { name: reference.name, id: reference.id } }
        }] }]), /invalid credential reference metadata/i);
        assert.throws(
            () => buildCredentialReferenceMap([], [reference]),
            /invalid credential reference metadata/i
        );
    }
});

test('rejects NUL metadata before credential key delimiter collisions', () => {
    assert.throws(() => collectCredentialReferences([{ nodes: [{ credentials: {
        ['alpha\u0000beta']: { name: 'gamma', id: 'target-a' },
        alpha: { name: 'beta\u0000gamma', id: 'target-b' }
    } }] }]), /invalid credential reference metadata/i);
});

test('maps credentials by exact target type and name', () => {
    const requiredRefs = [{ type: 'httpHeaderAuth', name: 'Header Auth account 2', id: 'source-id' }];
    const map = buildCredentialReferenceMap([{ nodes: [{ credentials: {
        httpHeaderAuth: { id: 'target-header-auth-id', name: 'Header Auth account 2' }
    } }] }], requiredRefs);

    assert.equal(map.get('httpHeaderAuth\u0000Header Auth account 2'), 'target-header-auth-id');
});

test('deduplicates repeated target references with the same type, name, and ID', () => {
    const requiredRefs = [{ type: 'httpHeaderAuth', name: 'Header Auth account 2', id: 'source-id' }];
    const targetRef = { httpHeaderAuth: { id: 'target-id', name: 'Header Auth account 2' } };
    const map = buildCredentialReferenceMap([
        { nodes: [{ credentials: targetRef }] },
        { nodes: [{ credentials: targetRef }] }
    ], requiredRefs);

    assert.equal(map.get('httpHeaderAuth\u0000Header Auth account 2'), 'target-id');
});

test('fails closed only when one type and name maps to distinct target IDs', () => {
    const requiredRefs = [{ type: 'httpHeaderAuth', name: 'Header Auth account 2', id: 'source-id' }];
    const ambiguousTargets = [{ nodes: [
        { credentials: { httpHeaderAuth: { id: 'target-a', name: 'Header Auth account 2' } } },
        { credentials: { httpHeaderAuth: { id: 'target-b', name: 'Header Auth account 2' } } }
    ] }];

    assert.throws(
        () => buildCredentialReferenceMap(ambiguousTargets, requiredRefs),
        /ambiguous credential reference/i
    );
});

test('fails closed for missing and type-mismatched target credentials', () => {
    const requiredRefs = [{ type: 'httpHeaderAuth', name: 'Header Auth account 2', id: 'shared-source-id' }];

    assert.throws(
        () => buildCredentialReferenceMap([], requiredRefs),
        /missing target credential reference/i
    );
    assert.throws(
        () => buildCredentialReferenceMap([{ nodes: [{ credentials: {
            slackApi: { id: 'shared-source-id', name: 'Header Auth account 2' }
        } }] }], requiredRefs),
        /missing target credential reference/i
    );
});

test('never falls back to the source credential ID', () => {
    const requiredRefs = [{
        type: 'httpHeaderAuth',
        name: 'Header Auth account 2',
        id: 'b39tXWu6AGQsbY2C'
    }];

    assert.throws(
        () => buildCredentialReferenceMap([{ nodes: [{ credentials: {
            httpHeaderAuth: { id: 'b39tXWu6AGQsbY2C', name: 'Different credential' }
        } }] }], requiredRefs),
        /missing target credential reference/i
    );
});

test('deep-clones nodes and remaps credential IDs while preserving type and name', () => {
    const nodes = [{
        name: 'HTTP Request',
        credentials: { httpHeaderAuth: { id: 'source-id', name: 'Header Auth account 2' } }
    }];
    const remapped = remapCredentialReferences(nodes, new Map([
        ['httpHeaderAuth\u0000Header Auth account 2', 'target-id']
    ]));

    assert.notStrictEqual(remapped, nodes);
    assert.notStrictEqual(remapped[0].credentials, nodes[0].credentials);
    assert.deepEqual(remapped[0].credentials.httpHeaderAuth, {
        id: 'target-id',
        name: 'Header Auth account 2'
    });
    assert.equal(nodes[0].credentials.httpHeaderAuth.id, 'source-id');
});

test('P2 creates exact inert skeletons for zero exact-name matches and returns all IDs', async () => {
    const inventory = getV3Inventory();
    const posts = [];
    const created = new Map();

    const ids = await provisionV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        approvalEvidence: P2_APPROVAL,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            if (method === 'GET' && url.includes('?')) {
                return response({
                    data: [...created].map(([id, name]) => workflowDetail(id, name)),
                    nextCursor: null
                });
            }
            if (method === 'POST') {
                const body = JSON.parse(options.body);
                posts.push(body);
                const id = `target-${posts.length}`;
                created.set(id, body.name);
                return response({ id });
            }
            const id = url.split('/').pop();
            return response(workflowDetail(id, created.get(id)));
        }
    });

    assert.equal(ids.size, inventory.length);
    assert.equal(posts.length, inventory.length);
    assert.deepEqual(posts, inventory.map(([name]) => ({ name, nodes: [], connections: {}, settings: {} })));
});

test('P2 requires independent P2 approval evidence before network access', async () => {
    let fetchCalls = 0;
    const options = {
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error('fetch must not be called');
        }
    };

    for (const approvalEvidence of [
        undefined,
        { approved: false, gate: 'P2', reference: 'P2-denied' },
        { approved: true, gate: 'P4', reference: 'wrong-gate' },
        { approved: true, gate: 'P2', reference: '   ' }
    ]) {
        await assert.rejects(
            provisionV3WorkflowInventory({ ...options, approvalEvidence }),
            /explicit P2 approval evidence/i
        );
    }
    assert.equal(fetchCalls, 0);
});

test('P2 re-fetches inventory after POST and reports created IDs on an interleaved duplicate', async () => {
    const inventory = getV3Inventory();
    const targets = [];
    const createdId = 'created-target-1';
    let listCalls = 0;
    let postCalls = 0;

    await assert.rejects(provisionV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        approvalEvidence: P2_APPROVAL,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            if (method === 'GET' && url.includes('?')) {
                listCalls += 1;
                if (listCalls === 2) {
                    targets.push(workflowDetail('competing-target', inventory[0][0]));
                }
                return response({ data: targets, nextCursor: null });
            }
            if (method === 'POST') {
                postCalls += 1;
                const body = JSON.parse(options.body);
                targets.push(workflowDetail(createdId, body.name));
                return response({ id: createdId });
            }
            return response(targets.find(workflow => workflow.id === url.split('/').pop()));
        }
    }), error => {
        assert.match(error.message, /multiple workflows exactly named/i);
        assert.deepEqual(error.createdWorkflowIds, [createdId]);
        return true;
    });
    assert.equal(postCalls, 1);
    assert.equal(listCalls, 2);
});

test('P2 reuses one inactive empty inert exact-name workflow without POST', async () => {
    const inventory = getV3Inventory();
    const targetWorkflows = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    const methods = [];

    const ids = await provisionV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        approvalEvidence: P2_APPROVAL,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            methods.push(method);
            if (url.includes('?')) return response({ data: targetWorkflows, nextCursor: null });
            return response(targetWorkflows.find(workflow => workflow.id === url.split('/').pop()));
        }
    });

    assert.equal(ids.size, inventory.length);
    assert.deepEqual([...ids.values()], targetWorkflows.map(workflow => workflow.id));
    assert.equal(methods.filter(method => method === 'POST').length, 0);
    assert.equal(methods.filter(method => method === 'PUT').length, 0);
});

test('P2 reuses inactive empty workflows with the n8n executionOrder default without POST', async () => {
    const inventory = getV3Inventory();
    const targetWorkflows = inventory.map(([name], index) => workflowDetail(`target-${index}`, name, {
        settings: { executionOrder: 'v1' }
    }));
    const methods = [];

    const ids = await provisionV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        approvalEvidence: P2_APPROVAL,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            methods.push(method);
            if (url.includes('?')) return response({ data: targetWorkflows, nextCursor: null });
            return response(targetWorkflows.find(workflow => workflow.id === url.split('/').pop()));
        }
    });

    assert.equal(ids.size, inventory.length);
    assert.equal(methods.filter(method => method === 'POST').length, 0);
    assert.equal(methods.filter(method => method === 'PUT').length, 0);
});

test('P2 accepts the n8n persisted defaults returned after fresh skeleton creation', async () => {
    const inventory = getV3Inventory();
    const created = new Map();
    let postCount = 0;

    const ids = await provisionV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        approvalEvidence: P2_APPROVAL,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            if (method === 'GET' && url.includes('?')) {
                return response({
                    data: [...created].map(([id, name]) => workflowDetail(id, name, {
                        settings: { callerPolicy: 'workflowsFromSameOwner', availableInMCP: false }
                    })),
                    nextCursor: null
                });
            }
            if (method === 'POST') {
                postCount += 1;
                const body = JSON.parse(options.body);
                const id = `target-${postCount}`;
                created.set(id, body.name);
                return response({ id });
            }
            const id = url.split('/').pop();
            return response(workflowDetail(id, created.get(id), {
                settings: { callerPolicy: 'workflowsFromSameOwner', availableInMCP: false }
            }));
        }
    });

    assert.equal(ids.size, inventory.length);
    assert.equal(postCount, inventory.length);
});

for (const [label, overrides, pattern] of [
    ['active', { active: true }, /active workflow/i],
    ['non-empty', { nodes: [{ name: 'Existing node' }] }, /non-empty or non-inert/i],
    ['connected', { connections: { Existing: {} } }, /non-empty or non-inert/i],
    ['non-inert', { settings: { saveExecutionProgress: true } }, /non-empty or non-inert/i],
    ['partial persisted defaults', { settings: { callerPolicy: 'workflowsFromSameOwner' } }, /non-empty or non-inert/i],
    ['unsafe persisted defaults', {
        settings: { callerPolicy: 'workflowsFromSameOwner', availableInMCP: true }
    }, /non-empty or non-inert/i]
]) {
    test(`P2 fails closed for one ${label} exact-name workflow before POST`, async () => {
        const inventory = getV3Inventory();
        const targetWorkflows = inventory.map(([name], index) => workflowDetail(
            `target-${index}`,
            name,
            index === inventory.length - 1 ? overrides : {}
        ));
        const methods = [];

        await assert.rejects(provisionV3WorkflowInventory({
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            approvalEvidence: P2_APPROVAL,
            fetchImpl: async (url, options = {}) => {
                methods.push(options.method || 'GET');
                if (url.includes('?')) return response({ data: targetWorkflows, nextCursor: null });
                return response(targetWorkflows.find(workflow => workflow.id === url.split('/').pop()));
            }
        }), pattern);
        assert.equal(methods.filter(method => method === 'POST').length, 0);
        assert.equal(methods.filter(method => method === 'PUT').length, 0);
    });
}

for (const [label, settings] of [
    ['a different executionOrder', { executionOrder: 'v2' }],
    ['an additional key', { executionOrder: 'v1', saveExecutionProgress: true }],
    ['a nested value', { executionOrder: { value: 'v1' } }],
    ['an array', []],
    ['a non-plain object', new Date(0)]
]) {
    test(`P2 fails closed for settings with ${label}`, async () => {
        const inventory = getV3Inventory();
        const targetWorkflows = inventory.map(([name], index) => workflowDetail(
            `target-${index}`,
            name,
            index === inventory.length - 1 ? { settings } : {}
        ));
        const methods = [];

        await assert.rejects(provisionV3WorkflowInventory({
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            approvalEvidence: P2_APPROVAL,
            fetchImpl: async (url, options = {}) => {
                methods.push(options.method || 'GET');
                if (url.includes('?')) return response({ data: targetWorkflows, nextCursor: null });
                return response(targetWorkflows.find(workflow => workflow.id === url.split('/').pop()));
            }
        }), /non-empty or non-inert/i);
        assert.equal(methods.filter(method => method === 'POST').length, 0);
        assert.equal(methods.filter(method => method === 'PUT').length, 0);
    });
}

test('P2 validates every existing match before the first POST', async () => {
    const inventory = getV3Inventory();
    const targetWorkflows = inventory.slice(1).map(([name], index) => workflowDetail(
        `target-${index + 1}`,
        name,
        index === inventory.length - 2 ? { active: true } : {}
    ));
    const methods = [];

    await assert.rejects(provisionV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        approvalEvidence: P2_APPROVAL,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            methods.push(method);
            if (url.includes('?')) return response({ data: targetWorkflows, nextCursor: null });
            return response(targetWorkflows.find(workflow => workflow.id === url.split('/').pop()));
        }
    }), /active workflow/i);
    assert.equal(methods.filter(method => method === 'POST').length, 0);
});

test('P2 fails closed for duplicate exact-name workflows before POST', async () => {
    const inventory = getV3Inventory();
    const targetWorkflows = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    targetWorkflows.push(workflowDetail('duplicate-target', inventory[0][0]));
    const methods = [];

    await assert.rejects(provisionV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        approvalEvidence: P2_APPROVAL,
        fetchImpl: async (_url, options = {}) => {
            methods.push(options.method || 'GET');
            return response({ data: targetWorkflows, nextCursor: null });
        }
    }), /multiple workflows exactly named/i);
    assert.deepEqual(methods, ['GET']);
});

test('P2 rerun reuses every created ID and performs no additional POST', async () => {
    const inventory = getV3Inventory();
    const targetWorkflows = [];
    let postCount = 0;
    const fetchImpl = async (url, options = {}) => {
        const method = options.method || 'GET';
        if (method === 'GET' && url.includes('?')) {
            return response({ data: targetWorkflows, nextCursor: null });
        }
        if (method === 'POST') {
            postCount += 1;
            const body = JSON.parse(options.body);
            const created = workflowDetail(`target-${postCount}`, body.name);
            targetWorkflows.push(created);
            return response({ id: created.id });
        }
        return response(targetWorkflows.find(workflow => workflow.id === url.split('/').pop()));
    };
    const options = {
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        approvalEvidence: P2_APPROVAL,
        fetchImpl
    };

    const first = await provisionV3WorkflowInventory(options);
    const postsAfterFirstRun = postCount;
    const second = await provisionV3WorkflowInventory(options);

    assert.equal(postsAfterFirstRun, inventory.length);
    assert.equal(postCount, postsAfterFirstRun);
    assert.deepEqual([...second], [...first]);
});

test('P4 requires independent P4 approval, one valid P3 artifact, and every P2 target ID before I/O', async () => {
    const inventory = getV3Inventory();
    const completeIds = new Map(inventory.map(([name], index) => [name, `target-${index}`]));
    const incompleteIds = new Map(completeIds);
    incompleteIds.delete(inventory[inventory.length - 1][0]);
    const artifact = JSON.parse(JSON.stringify(await createP3Artifact()));
    let fetchCalls = 0;
    const options = {
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir: '/unused',
        fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error('fetch must not be called');
        }
    };

    for (const invalid of [
        { p3Artifact: artifact, targetWorkflowIds: completeIds },
        {
            approvalEvidence: { approved: false, gate: 'P4', reference: 'P4-denied' },
            p3Artifact: artifact,
            targetWorkflowIds: completeIds
        },
        {
            approvalEvidence: { approved: true, gate: 'P2', reference: 'wrong-gate' },
            p3Artifact: artifact,
            targetWorkflowIds: completeIds
        },
        {
            approvalEvidence: { approved: true, gate: 'P4', reference: '   ' },
            p3Artifact: artifact,
            targetWorkflowIds: completeIds
        }
    ]) {
        await assert.rejects(
            deployV3WorkflowInventory({ ...options, ...invalid }),
            /explicit P4 approval evidence/i
        );
    }
    await assert.rejects(
        deployV3WorkflowInventory({
            ...options,
            approvalEvidence: p4ApprovalFor(artifact),
            p3Artifact: artifact,
            targetWorkflowIds: incompleteIds
        }),
        /complete P2 target workflow IDs/i
    );
    assert.equal(fetchCalls, 0);
});

test('P4 rejects substituted or tampered P3 artifacts before workflow filesystem or network I/O', async () => {
    const inventory = getV3Inventory();
    const completeIds = new Map(inventory.map(([name], index) => [name, `target-${index}`]));
    const valid = JSON.parse(JSON.stringify(await createP3Artifact()));
    const tampered = (mutate) => {
        const artifact = structuredClone(valid);
        mutate(artifact);
        return artifact;
    };
    const cases = [
        { label: 'missing artifact', artifact: undefined },
        { label: 'Map substitution', artifact: dataTableIdMap() },
        { label: 'wrong version', artifact: tampered(value => { value.version = 2; }) },
        { label: 'wrong gate', artifact: tampered(value => { value.gate = 'P4'; }) },
        { label: 'missing P3 evidence', artifact: tampered(value => { value.approvalReference = ''; }) },
        {
            label: 'canonical schema digest',
            artifact: tampered(value => { value.canonicalSchemaDigest = '0'.repeat(64); })
        },
        { label: 'artifact digest', artifact: tampered(value => { value.artifactDigest = '0'.repeat(64); }) },
        { label: 'table ID', artifact: tampered(value => { value.tables[0].id = 'substitute-id'; }) },
        { label: 'table name', artifact: tampered(value => { value.tables[0].name = 'substitute_name'; }) },
        {
            label: 'table columns',
            artifact: tampered(value => { value.tables[0].columns[0].type = 'number'; })
        }
    ];
    let fetchCalls = 0;

    for (const testCase of cases) {
        await assert.rejects(deployV3WorkflowInventoryWithoutDefaults({
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            rootDir: '/path-that-must-not-be-read',
            approvalEvidence: p4ApprovalFor(valid),
            p3Artifact: testCase.artifact,
            targetWorkflowIds: completeIds,
            fetchImpl: async () => {
                fetchCalls += 1;
                throw new Error('fetch must not be called');
            }
        }), /P3 artifact|schema digest|artifact digest|approval reference|version|gate/i, testCase.label);
    }

    await assert.rejects(deployV3WorkflowInventoryWithoutDefaults({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir: '/path-that-must-not-be-read',
        approvalEvidence: p4ApprovalFor(valid),
        p3SchemaEvidence: P3_EVIDENCE,
        targetDataTableIds: dataTableIdMap(),
        targetWorkflowIds: completeIds,
        fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error('fetch must not be called');
        }
    }), /P3 artifact/i);
    assert.equal(fetchCalls, 0);
});

test('P4 approval binds the exact validated P3 artifact digest before filesystem or network I/O', async () => {
    const inventory = getV3Inventory();
    const targetWorkflowIds = new Map(inventory.map(([name], index) => [name, `target-${index}`]));
    const artifact = JSON.parse(JSON.stringify(await createP3Artifact()));
    let fetchCalls = 0;
    const invoke = (p3Artifact, approvalEvidence) => deployV3WorkflowInventoryWithoutDefaults({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir: '/path-that-must-not-be-read',
        approvalEvidence,
        p3Artifact,
        targetWorkflowIds,
        fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error('fetch must not be called');
        }
    });

    for (const approvedP3ArtifactDigest of [
        undefined,
        '0'.repeat(64),
        artifact.artifactDigest.toUpperCase(),
        `${artifact.artifactDigest}\u0000`
    ]) {
        await assert.rejects(
            invoke(artifact, p4ApprovalFor(artifact, { approvedP3ArtifactDigest })),
            /approved P3 artifact digest|approval evidence/i
        );
    }

    const independentlyValidTamper = structuredClone(artifact);
    independentlyValidTamper.tables[0].id = 'independently-recomputed-id';
    recomputeArtifactDigest(independentlyValidTamper);
    await assert.rejects(
        invoke(independentlyValidTamper, p4ApprovalFor(artifact)),
        /approved P3 artifact digest.*does not match|digest mismatch/i
    );
    assert.equal(fetchCalls, 0);
});

test('P4 artifact validation is key-order independent and bounded against hostile JSON-like input', async () => {
    const inventory = getV3Inventory();
    const targetWorkflowIds = new Map(inventory.map(([name], index) => [name, `target-${index}`]));
    const valid = JSON.parse(JSON.stringify(await createP3Artifact()));
    let fetchCalls = 0;
    const invoke = artifact => deployV3WorkflowInventoryWithoutDefaults({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir: '/path-that-must-not-be-read',
        approvalEvidence: p4ApprovalFor(valid),
        p3Artifact: artifact,
        targetWorkflowIds,
        fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error('fetch must not be called');
        }
    });
    const mutate = callback => {
        const artifact = structuredClone(valid);
        callback(artifact);
        return artifact;
    };

    const reordered = {
        tables: valid.tables.map(table => ({
            columns: table.columns.map(column => ({ type: column.type, name: column.name })),
            id: table.id,
            name: table.name
        })),
        canonicalSchemaDigest: valid.canonicalSchemaDigest,
        artifactDigest: valid.artifactDigest,
        approvalReference: valid.approvalReference,
        gate: valid.gate,
        version: valid.version
    };
    await assert.rejects(invoke(reordered), /File not found/i);

    const cycle = structuredClone(valid);
    cycle.unexpected = cycle;
    const customPrototype = structuredClone(valid);
    Object.setPrototypeOf(customPrototype, { polluted: true });
    const oversizedTables = structuredClone(valid);
    oversizedTables.tables = new Array(100_000);
    Object.defineProperty(oversizedTables.tables, 0, {
        get() { throw new Error('table traversal occurred before length validation'); }
    });
    const oversizedColumns = structuredClone(valid);
    oversizedColumns.tables[0].columns = new Array(100_000);
    Object.defineProperty(oversizedColumns.tables[0].columns, 0, {
        get() { throw new Error('column traversal occurred before length validation'); }
    });
    const oversizedArtifact = mutate(value => {
        value.approvalReference = 'r'.repeat(4096);
        value.tables.forEach((table, index) => { table.id = `${index}-${'i'.repeat(4094)}`; });
    });
    const customTablesArray = structuredClone(valid);
    Object.setPrototypeOf(customTablesArray.tables, Object.create(Array.prototype));
    const customColumnsArray = structuredClone(valid);
    Object.setPrototypeOf(customColumnsArray.tables[0].columns, Object.create(Array.prototype));
    const extraTablesArrayProperty = structuredClone(valid);
    extraTablesArrayProperty.tables.extra = true;
    const extraColumnsArrayProperty = structuredClone(valid);
    extraColumnsArrayProperty.tables[0].columns.extra = true;
    const tableAccessor = structuredClone(valid);
    Object.defineProperty(tableAccessor.tables, 0, {
        enumerable: true,
        configurable: true,
        get() { throw new Error('table accessor executed'); }
    });
    const columnAccessor = structuredClone(valid);
    Object.defineProperty(columnAccessor.tables[0].columns, 0, {
        enumerable: true,
        configurable: true,
        get() { throw new Error('column accessor executed'); }
    });
    const hostileCases = [
        cycle,
        customPrototype,
        mutate(value => { value.extra = true; }),
        mutate(value => { value.approvalReference = undefined; }),
        mutate(value => { value.version = Number.POSITIVE_INFINITY; }),
        mutate(value => { value.version = 1.5; }),
        mutate(value => { value.approvalReference = ' P3-reference '; }),
        mutate(value => { value.approvalReference = 'P3\u0000reference'; }),
        mutate(value => { value.approvalReference = 'r'.repeat(4097); }),
        mutate(value => { value.tables[0].id = ''; }),
        mutate(value => { value.tables[0].id = 'id\u0000value'; }),
        mutate(value => { value.tables[0].id = 'i'.repeat(4097); }),
        mutate(value => { value.tables[0].extra = true; }),
        mutate(value => { Object.setPrototypeOf(value.tables[0], { polluted: true }); }),
        mutate(value => { value.tables[0].columns[0].extra = true; }),
        mutate(value => { Object.setPrototypeOf(value.tables[0].columns[0], { polluted: true }); }),
        customTablesArray,
        customColumnsArray,
        extraTablesArrayProperty,
        extraColumnsArrayProperty,
        tableAccessor,
        columnAccessor,
        oversizedTables,
        oversizedColumns
    ];

    for (const artifact of hostileCases) {
        await assert.rejects(
            invoke(artifact),
            error => error instanceof Error && !/Maximum call stack|traversal occurred|accessor executed/i.test(error.message)
        );
    }
    await assert.rejects(invoke(oversizedArtifact), /exceeds.*byte limit/i);
    assert.equal(fetchCalls, 0);
});

test('P4 resolves all IDs before credential maps and performs no PUT on preflight failure', async t => {
    const inventory = getV3Inventory();
    const rootDir = createInventorySourceTree(t, name => name === inventory[0][0] ? {
        nodes: [{
            name: 'HTTP Request',
            credentials: { httpHeaderAuth: { id: 'source-id', name: 'Header Auth account 2' } }
        }]
    } : {});
    const ids = new Map(inventory.map(([name], index) => [name, `target-${index}`]));
    const missingName = inventory[inventory.length - 1][0];
    const targetWorkflows = inventory.slice(0, -1).map(([name], index) => workflowDetail(`target-${index}`, name));
    targetWorkflows.push({
        id: 'credential-a',
        name: 'Credential donor A',
        nodes: [{ credentials: { httpHeaderAuth: { id: 'a', name: 'Header Auth account 2' } } }]
    }, {
        id: 'credential-b',
        name: 'Credential donor B',
        nodes: [{ credentials: { httpHeaderAuth: { id: 'b', name: 'Header Auth account 2' } } }]
    });
    const methods = [];

    await assert.rejects(deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (_url, options = {}) => {
            methods.push(options.method || 'GET');
            return response({ data: targetWorkflows, nextCursor: null });
        }
    }), new RegExp(`P2 target workflow.*${missingName}`, 'i'));
    assert.equal(methods.filter(method => method === 'PUT').length, 0);
});

test('P4 completes every selector remap before the first PUT', async t => {
    const inventory = getV3Inventory();
    const lastName = inventory[inventory.length - 1][0];
    const rootDir = createInventorySourceTree(t, name => name === lastName ? {
        nodes: [{
            name: 'Call unknown workflow',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: {
                workflowId: {
                    value: 'unknown-source-id',
                    cachedResultName: 'Unknown workflow'
                }
            }
        }]
    } : {});
    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
    let putCalls = 0;

    await assert.rejects(deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (_url, options = {}) => {
            if (options.method === 'PUT') putCalls += 1;
            return response({ data: targets, nextCursor: null });
        }
    }), /references unknown workflow "Unknown workflow"/i);
    assert.equal(putCalls, 0);
});

test('P4 deep-clones and remaps Data Tables, selectors, and credentials before PUT, then confirms inactive', async t => {
    const inventory = getV3Inventory();
    const callerName = inventory[0][0];
    const childName = inventory[1][0];
    const rootDir = createInventorySourceTree(t, name => name === callerName ? {
        nodes: [
            {
                name: 'Call child',
                type: 'n8n-nodes-base.executeWorkflow',
                parameters: {
                    workflowId: {
                        value: `${childName}-source-id`,
                        cachedResultName: childName,
                        cachedResultUrl: `/workflow/${childName}-source-id`
                    }
                },
                credentials: {
                    httpHeaderAuth: { id: 'b39tXWu6AGQsbY2C', name: 'Header Auth account 2' }
                }
            },
            {
                name: 'Call existing inference workflow',
                type: 'n8n-nodes-base.executeWorkflow',
                parameters: {
                    workflowId: {
                        value: 'external-inference-source-id',
                        cachedResultName: 'Existing inference workflow',
                        cachedResultUrl: '/workflow/external-inference-source-id'
                    }
                }
            },
            {
                name: 'Jobs table',
                type: 'n8n-nodes-base.dataTable',
                parameters: {
                    dataTableId: { __rl: true, mode: 'name', value: 'stt_jobs_v3' }
                }
            }
        ]
    } : {});
    const targetWorkflows = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    targetWorkflows.push({
        id: 'credential-donor',
        name: 'Credential donor',
        nodes: [{ credentials: {
            httpHeaderAuth: { id: 'target-header-auth-id', name: 'Header Auth account 2' }
        } }]
    });
    targetWorkflows.push(workflowDetail(
        'external-inference-target-id',
        'Existing inference workflow',
        { nodes: [{ name: 'Existing inference node' }] }
    ));
    const ids = new Map(targetWorkflows.slice(0, inventory.length).map(workflow => [workflow.name, workflow.id]));
    const putPayloads = [];
    const methods = [];

    await deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            methods.push(method);
            if (method === 'GET' && url.includes('?')) {
                return response({ data: targetWorkflows, nextCursor: null });
            }
            const target = targetWorkflows.find(workflow => workflow.id === url.split('/').pop());
            if (method === 'PUT') {
                const payload = JSON.parse(options.body);
                putPayloads.push(payload);
                Object.assign(target, payload, { active: false });
                if (target.name === inventory[inventory.length - 1][0]) {
                    target.settings = { ...target.settings, executionOrder: 'v1' };
                }
                return response(target);
            }
            return response(target);
        }
    });

    assert.equal(putPayloads.length, inventory.length);
    assert.deepEqual(putPayloads.map(payload => payload.name), inventory.map(([name]) => name));
    assert.equal(putPayloads[0].nodes[0].parameters.workflowId.value, ids.get(childName));
    assert.equal(putPayloads[0].nodes[0].parameters.workflowId.cachedResultUrl, `/workflow/${ids.get(childName)}`);
    assert.deepEqual(putPayloads[0].nodes[0].credentials.httpHeaderAuth, {
        id: 'target-header-auth-id',
        name: 'Header Auth account 2'
    });
    assert.equal(putPayloads[0].nodes[1].parameters.workflowId.value, 'external-inference-target-id');
    assert.equal(
        putPayloads[0].nodes[1].parameters.workflowId.cachedResultUrl,
        '/workflow/external-inference-target-id'
    );
    assert.deepEqual(putPayloads[0].nodes[2].parameters.dataTableId, {
        __rl: true,
        mode: 'id',
        value: 'table-jobs'
    });
    assert.equal(methods.filter(method => method === 'POST').length, 0);
    assert.equal(methods.filter(method => method === 'PUT').length, inventory.length);
    assert.equal(
        methods.slice(methods.indexOf('PUT')).filter(method => method === 'GET').length,
        inventory.length * 2
    );
});

test('P4 rejects an invalid source Data Table locator during joint preflight before any PUT', async t => {
    const inventory = getV3Inventory();
    const rootDir = createInventorySourceTree(t, name => name === inventory[0][0] ? {
        nodes: [{
            name: 'Source table ID',
            type: 'n8n-nodes-base.dataTable',
            parameters: {
                dataTableId: { __rl: true, mode: 'id', value: 'source-table-id' }
            }
        }]
    } : {});
    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
    let putCalls = 0;

    await assert.rejects(deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (_url, options = {}) => {
            if (options.method === 'PUT') putCalls += 1;
            return response({ data: targets, nextCursor: null });
        }
    }), /invalid authoritative Data Table placeholder/i);
    assert.equal(putCalls, 0);
});

test('P4 stops later PUTs when post-PUT GET returns a non-P3 Data Table target ID', async t => {
    const inventory = getV3Inventory();
    const rootDir = createInventorySourceTree(t, name => name === inventory[0][0] ? {
        nodes: [{
            name: 'Jobs table',
            type: 'n8n-nodes-base.dataTable',
            parameters: {
                dataTableId: { __rl: true, mode: 'name', value: 'stt_jobs_v3' }
            }
        }]
    } : {});
    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
    const targetById = new Map(targets.map(workflow => [workflow.id, workflow]));
    const putIds = [];

    await assert.rejects(deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            if (method === 'GET' && url.includes('?')) {
                return response({ data: targets, nextCursor: null });
            }
            const target = targetById.get(url.split('/').pop());
            if (method === 'PUT') {
                putIds.push(target.id);
                Object.assign(target, JSON.parse(options.body), { active: false });
                target.nodes[0].parameters.dataTableId.value = 'wrong-target-table-id';
                return response(target);
            }
            return response(target);
        }
    }), /approved P3 target ID|does not match expected deployable content/i);
    assert.deepEqual(putIds, ['target-0']);
});

test('P4 treats exact deployed content as completed and accepts only safe executionOrder normalization', async t => {
    const inventory = getV3Inventory();
    const firstName = inventory[0][0];
    const rootDir = createInventorySourceTree(t, name => name === firstName ? {
        description: 'Required workflow description'
    } : {});
    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name, {
        nodes: [{ name: 'Source', type: 'n8n-nodes-base.noOp', parameters: {} }],
        settings: {
            callerPolicy: 'workflowsFromSameOwner',
            availableInMCP: false,
            ...(index === inventory.length - 1 ? { executionOrder: 'v1' } : {})
        },
        ...(name === firstName ? { description: 'Required workflow description' } : {})
    }));
    const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
    const targetById = new Map(targets.map(workflow => [workflow.id, workflow]));
    let putCalls = 0;

    await deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (url, options = {}) => {
            if (options.method === 'PUT') putCalls += 1;
            if (url.includes('?')) return response({ data: targets, nextCursor: null });
            return response(targetById.get(url.split('/').pop()));
        }
    });

    assert.equal(putCalls, 0);
});

test('P4 rechecks a pending target immediately before PUT and rejects an intervening change', async t => {
    const inventory = getV3Inventory();
    const rootDir = createInventorySourceTree(t);
    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
    const targetById = new Map(targets.map(workflow => [workflow.id, workflow]));
    let putCalls = 0;
    let changed = false;

    await assert.rejects(deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            if (method === 'GET' && url.includes('?')) {
                return response({ data: targets, nextCursor: null });
            }
            const target = targetById.get(url.split('/').pop());
            if (method === 'PUT') {
                putCalls += 1;
                Object.assign(target, JSON.parse(options.body), { active: false });
                return response(target);
            }
            if (!changed && target.id === 'target-0' && putCalls === 0) {
                changed = true;
                target.nodes = [{ name: 'Competing node' }];
            }
            return response(target);
        }
    }), /changed before PUT|inactive inert skeleton before PUT/i);
    assert.equal(putCalls, 0);
});

test('P4 pre-PUT failures include recovery metadata and never overwrite the failed target', async t => {
    const inventory = getV3Inventory();

    for (const testCase of [
        { failIndex: 2, mode: 'throw' },
        { failIndex: inventory.length - 1, mode: 'nonempty' }
    ]) {
        const rootDir = createInventorySourceTree(t);
        const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
        const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
        const targetById = new Map(targets.map(workflow => [workflow.id, workflow]));
        const putIds = [];

        await assert.rejects(deployV3WorkflowInventory({
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            rootDir,
            approvalEvidence: P4_APPROVAL,
            targetWorkflowIds: ids,
            fetchImpl: async (url, options = {}) => {
                const method = options.method || 'GET';
                if (method === 'GET' && url.includes('?')) {
                    return response({ data: targets, nextCursor: null });
                }
                const id = url.split('/').pop();
                const target = targetById.get(id);
                const isPrePutGet = method === 'GET' && !putIds.includes(id);
                if (isPrePutGet && id === `target-${testCase.failIndex}`) {
                    if (testCase.mode === 'throw') throw new Error('mock pre-PUT GET failure');
                    target.nodes = [{ name: 'Competing node' }];
                }
                if (method === 'PUT') {
                    putIds.push(id);
                    Object.assign(target, JSON.parse(options.body), { active: false });
                    return response(target);
                }
                return response(target);
            }
        }), error => {
            assert.equal(error.failedWorkflowName, inventory[testCase.failIndex][0]);
            assert.deepEqual(
                error.completedWorkflowIds,
                inventory.slice(0, testCase.failIndex).map((_, index) => `target-${index}`)
            );
            assert.deepEqual(
                error.pendingWorkflowIds,
                inventory.slice(testCase.failIndex).map((_, index) => `target-${index + testCase.failIndex}`)
            );
            return true;
        });
        assert.deepEqual(
            putIds,
            inventory.slice(0, testCase.failIndex).map((_, index) => `target-${index}`)
        );
    }
});

test('P4 replans latest credential authority before the first PUT and rejects drift with zero mutations', async t => {
    const fixture = createCredentialP4Fixture(t);
    let listCalls = 0;
    let putCalls = 0;

    await assert.rejects(deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir: fixture.rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: fixture.ids,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            if (method === 'GET' && url.includes('?')) {
                listCalls += 1;
                if (listCalls === 2) {
                    fixture.donor.nodes[0].credentials.httpHeaderAuth.id = 'new-credential-id';
                }
                return response({ data: fixture.targets, nextCursor: null });
            }
            const target = fixture.targetById.get(url.split('/').pop());
            if (method === 'PUT') {
                putCalls += 1;
                Object.assign(target, JSON.parse(options.body), { active: false });
                return response(target);
            }
            return response(target);
        }
    }), error => {
        assert.match(error.message, /authority|plan.*drift/i);
        assert.deepEqual(error.completedWorkflowIds, []);
        assert.deepEqual(error.pendingWorkflowIds, fixture.inventory.map((_, index) => `target-${index}`));
        return true;
    });
    assert.equal(listCalls, 2);
    assert.equal(putCalls, 0);
});

test('P4 ignores unrelated workflow add, remove, and reorder during pre-mutation and final replans', async t => {
    const inventory = getV3Inventory();
    const rootDir = createInventorySourceTree(t);
    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
    const targetById = new Map(targets.map(workflow => [workflow.id, workflow]));
    let listCalls = 0;

    await deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            if (method === 'GET' && url.includes('?')) {
                listCalls += 1;
                if (listCalls === 1) {
                    return response({
                        data: [...targets, { id: 'unrelated-a', name: 'Unrelated A', nodes: [] }],
                        nextCursor: null
                    });
                }
                if (listCalls === 2) {
                    return response({
                        data: [{ id: 'unrelated-b', name: 'Unrelated B', nodes: [] }, ...targets].reverse(),
                        nextCursor: null
                    });
                }
                return response({
                    data: [{ id: 'unrelated-c', name: 'Unrelated C', nodes: [] }, ...targets],
                    nextCursor: null
                });
            }
            const target = targetById.get(url.split('/').pop());
            if (method === 'PUT') {
                Object.assign(target, JSON.parse(options.body), { active: false });
                return response(target);
            }
            return response(target);
        }
    });
    assert.equal(listCalls, 3);
});

test('P4 still fails closed when a required static selector authority disappears', async t => {
    const inventory = getV3Inventory();
    const firstName = inventory[0][0];
    const rootDir = createInventorySourceTree(t, name => name === firstName ? {
        nodes: [{
            name: 'Call external target',
            type: 'n8n-nodes-base.executeWorkflow',
            parameters: { workflowId: 'external-target-id' }
        }]
    } : {});
    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    const externalTarget = { id: 'external-target-id', name: 'External target', nodes: [] };
    const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
    let listCalls = 0;
    let putCalls = 0;

    await assert.rejects(deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (url, options = {}) => {
            if ((options.method || 'GET') === 'GET' && url.includes('?')) {
                listCalls += 1;
                return response({
                    data: listCalls === 1 ? [...targets, externalTarget] : targets,
                    nextCursor: null
                });
            }
            if (options.method === 'PUT') putCalls += 1;
            return response({});
        }
    }), error => {
        assert.match(error.message, /unknown static workflow ID "external-target-id"/i);
        assert.deepEqual(error.completedWorkflowIds, []);
        assert.deepEqual(error.pendingWorkflowIds, inventory.map((_, index) => `target-${index}`));
        return true;
    });
    assert.equal(putCalls, 0);
});

test('P4 rechecks an initially completed target before skip and rejects divergence', async t => {
    const inventory = getV3Inventory();
    const rootDir = createInventorySourceTree(t);
    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name, {
        nodes: [{ name: 'Source', type: 'n8n-nodes-base.noOp', parameters: {} }]
    }));
    const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
    const targetById = new Map(targets.map(workflow => [workflow.id, workflow]));
    let putCalls = 0;
    let changed = false;

    await assert.rejects(deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            if (method === 'GET' && url.includes('?')) {
                return response({ data: targets, nextCursor: null });
            }
            if (method === 'PUT') {
                putCalls += 1;
                return response({});
            }
            const target = targetById.get(url.split('/').pop());
            if (!changed && target.id === 'target-0') {
                changed = true;
                target.connections = { Competing: {} };
            }
            return response(target);
        }
    }), error => {
        assert.match(error.message, /completed target.*diverged|does not match expected deployable content/i);
        assert.equal(error.failedWorkflowName, inventory[0][0]);
        assert.equal(error.failedWorkflowId, 'target-0');
        assert.deepEqual(error.completedWorkflowIds, []);
        assert.deepEqual(error.pendingWorkflowIds, inventory.map((_, index) => `target-${index}`));
        return true;
    });
    assert.equal(putCalls, 0);
});

test('P4 completed-skip recovery metadata covers GET failure, identity drift, and locator drift', async t => {
    const inventory = getV3Inventory();

    for (const failureMode of ['network', 'identity', 'locator']) {
        await t.test(failureMode, async () => {
            const firstName = inventory[0][0];
            const locatorNode = {
                id: 'jobs-node',
                name: 'Jobs table',
                type: 'n8n-nodes-base.dataTable',
                parameters: { dataTableId: { __rl: true, mode: 'name', value: 'stt_jobs_v3' } }
            };
            const rootDir = createInventorySourceTree(t, name => (
                failureMode === 'locator' && name === firstName ? { nodes: [locatorNode] } : {}
            ));
            const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name, {
                nodes: failureMode === 'locator' && name === firstName
                    ? [{
                        ...structuredClone(locatorNode),
                        parameters: {
                            dataTableId: { __rl: true, mode: 'id', value: 'table-jobs' }
                        }
                    }]
                    : [{ name: 'Source', type: 'n8n-nodes-base.noOp', parameters: {} }]
            }));
            const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
            const targetById = new Map(targets.map(workflow => [workflow.id, workflow]));

            await assert.rejects(deployV3WorkflowInventory({
                apiUrl: 'https://unused.invalid',
                apiKey: 'test-key',
                rootDir,
                approvalEvidence: P4_APPROVAL,
                targetWorkflowIds: ids,
                fetchImpl: async (url, options = {}) => {
                    if ((options.method || 'GET') === 'GET' && url.includes('?')) {
                        return response({ data: targets, nextCursor: null });
                    }
                    const target = targetById.get(url.split('/').pop());
                    if (target.id !== 'target-0') return response(target);
                    if (failureMode === 'network') throw new Error('completed readback network failure');
                    if (failureMode === 'identity') return response({ ...target, name: 'Drifted identity' });
                    const drifted = structuredClone(target);
                    drifted.nodes[0].parameters.dataTableId.value = 'table-summaries';
                    return response(drifted);
                }
            }), error => {
                assert.equal(error.failedWorkflowName, firstName);
                assert.equal(error.failedWorkflowId, 'target-0');
                assert.deepEqual(error.completedWorkflowIds, []);
                assert.deepEqual(error.pendingWorkflowIds, inventory.map((_, index) => `target-${index}`));
                return true;
            });
        });
    }
});

test('P4 accepts description null returned by post-PUT GET when source description is omitted', async t => {
    const inventory = getV3Inventory();
    const rootDir = createInventorySourceTree(t);
    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
    const targetById = new Map(targets.map(workflow => [workflow.id, workflow]));

    await deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            if (method === 'GET' && url.includes('?')) {
                return response({ data: targets, nextCursor: null });
            }
            const target = targetById.get(url.split('/').pop());
            if (method === 'PUT') {
                Object.assign(target, JSON.parse(options.body), { active: false, description: null });
                return response(target);
            }
            return response(target);
        }
    });
});

test('P4 final inventory verification rejects drift after all per-workflow checks', async t => {
    const inventory = getV3Inventory();
    const rootDir = createInventorySourceTree(t);
    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
    const targetById = new Map(targets.map(workflow => [workflow.id, workflow]));
    let listCalls = 0;

    await assert.rejects(deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            if (method === 'GET' && url.includes('?')) {
                listCalls += 1;
                if (listCalls === 3) {
                    targets[targets.length - 1].nodes = [{ name: 'Late competing node' }];
                }
                return response({ data: targets, nextCursor: null });
            }
            const target = targetById.get(url.split('/').pop());
            if (method === 'PUT') {
                Object.assign(target, JSON.parse(options.body), { active: false });
                return response(target);
            }
            return response(target);
        }
    }), /Final target workflow.*does not match expected deployable content/i);
    assert.equal(listCalls, 3);
});

test('P4 final authority verification rejects a changed credential map with recovery metadata', async t => {
    const fixture = createCredentialP4Fixture(t);
    let listCalls = 0;

    await assert.rejects(deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir: fixture.rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: fixture.ids,
        fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            if (method === 'GET' && url.includes('?')) {
                listCalls += 1;
                if (listCalls === 3) {
                    fixture.donor.nodes[0].credentials.httpHeaderAuth.id = 'changed-final-credential-id';
                    fixture.targets[0].nodes[0].credentials.httpHeaderAuth.id = 'changed-final-credential-id';
                }
                return response({ data: fixture.targets, nextCursor: null });
            }
            const target = fixture.targetById.get(url.split('/').pop());
            if (method === 'PUT') {
                Object.assign(target, JSON.parse(options.body), { active: false });
                return response(target);
            }
            return response(target);
        }
    }), error => {
        assert.match(error.message, /final.*authority|credential.*drift/i);
        assert.deepEqual(error.completedWorkflowIds, fixture.inventory.map((_, index) => `target-${index}`));
        assert.deepEqual(error.pendingWorkflowIds, []);
        return true;
    });
    assert.equal(listCalls, 3);
});

test('P4 final authority verification rejects missing and ambiguous credential references', async t => {
    for (const drift of ['missing', 'ambiguous']) {
        const fixture = createCredentialP4Fixture(t);
        let listCalls = 0;

        await assert.rejects(deployV3WorkflowInventory({
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            rootDir: fixture.rootDir,
            approvalEvidence: P4_APPROVAL,
            targetWorkflowIds: fixture.ids,
            fetchImpl: async (url, options = {}) => {
                const method = options.method || 'GET';
                if (method === 'GET' && url.includes('?')) {
                    listCalls += 1;
                    if (listCalls === 3 && drift === 'missing') {
                        fixture.targets.splice(fixture.targets.indexOf(fixture.donor), 1);
                        delete fixture.targets[0].nodes[0].credentials;
                    }
                    if (listCalls === 3 && drift === 'ambiguous') {
                        fixture.targets.push({
                            id: 'second-credential-donor',
                            name: 'Second credential donor',
                            nodes: [{ credentials: {
                                httpHeaderAuth: {
                                    id: 'ambiguous-credential-id',
                                    name: 'Header Auth account 2'
                                }
                            } }]
                        });
                    }
                    return response({ data: fixture.targets, nextCursor: null });
                }
                const target = fixture.targetById.get(url.split('/').pop());
                if (method === 'PUT') {
                    Object.assign(target, JSON.parse(options.body), { active: false });
                    return response(target);
                }
                return response(target);
            }
        }), error => {
            assert.match(error.message, /missing target|ambiguous credential/i, drift);
            assert.deepEqual(error.completedWorkflowIds, fixture.inventory.map((_, index) => `target-${index}`));
            assert.deepEqual(error.pendingWorkflowIds, []);
            return true;
        });
        assert.equal(listCalls, 3);
    }
});

test('P4 PUT failures expose recovery metadata and reruns PUT only pending workflows', async t => {
    const inventory = getV3Inventory();

    for (const failIndex of [1, inventory.length - 1]) {
        const rootDir = createInventorySourceTree(t);
        const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
        const ids = new Map(targets.map(workflow => [workflow.name, workflow.id]));
        const targetById = new Map(targets.map(workflow => [workflow.id, workflow]));
        const putIds = [];
        let failOnce = true;
        const fetchImpl = async (url, options = {}) => {
            const method = options.method || 'GET';
            if (method === 'GET' && url.includes('?')) {
                return response({ data: targets, nextCursor: null });
            }
            const id = url.split('/').pop();
            const target = targetById.get(id);
            if (method === 'PUT') {
                putIds.push(id);
                if (failOnce && id === `target-${failIndex}`) {
                    return failedResponse(500, `failed ${target.name}`);
                }
                Object.assign(target, JSON.parse(options.body), { active: false, description: null });
                return response(target);
            }
            return response(target);
        };
        const options = {
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            rootDir,
            approvalEvidence: P4_APPROVAL,
            targetWorkflowIds: ids,
            fetchImpl
        };

        await assert.rejects(deployV3WorkflowInventory(options), error => {
            assert.equal(error.failedWorkflowName, inventory[failIndex][0]);
            assert.deepEqual(error.completedWorkflowIds, inventory.slice(0, failIndex).map((_, index) => `target-${index}`));
            assert.deepEqual(error.pendingWorkflowIds, inventory.slice(failIndex).map((_, index) => `target-${index + failIndex}`));
            return true;
        });

        const firstRunPutIds = [...putIds];
        assert.deepEqual(firstRunPutIds, inventory.slice(0, failIndex + 1).map((_, index) => `target-${index}`));
        failOnce = false;
        putIds.length = 0;
        await deployV3WorkflowInventory(options);
        assert.deepEqual(putIds, inventory.slice(failIndex).map((_, index) => `target-${index + failIndex}`));
    }
});

test('P4 verifies full deployed identity and content after every PUT', async t => {
    const inventory = getV3Inventory();
    const firstName = inventory[0][0];
    const cases = [
        {
            label: 'empty skeleton',
            configure: () => ({}),
            mutate: target => Object.assign(target, { active: false })
        },
        {
            label: 'stale credential ID',
            configure: name => name === firstName ? {
                nodes: [{
                    name: 'HTTP Request',
                    type: 'n8n-nodes-base.httpRequest',
                    parameters: {},
                    credentials: { httpHeaderAuth: { id: 'source-id', name: 'Header Auth account 2' } }
                }]
            } : {},
            donor: {
                id: 'credential-donor',
                name: 'Credential donor',
                nodes: [{ credentials: {
                    httpHeaderAuth: { id: 'target-credential-id', name: 'Header Auth account 2' }
                } }]
            },
            mutate: (target, payload) => {
                Object.assign(target, payload, { active: false });
                target.nodes[0].credentials.httpHeaderAuth.id = 'stale-credential-id';
            }
        },
        {
            label: 'missing connection',
            configure: name => name === firstName ? {
                connections: { Source: { main: [[{ node: 'Next', type: 'main', index: 0 }]] } }
            } : {},
            mutate: (target, payload) => Object.assign(target, payload, { active: false, connections: {} })
        },
        {
            label: 'wrong workflow ID',
            configure: () => ({}),
            mutate: (target, payload) => Object.assign(target, payload, { active: false, id: 'wrong-target-id' })
        },
        {
            label: 'wrong workflow name',
            configure: () => ({}),
            mutate: (target, payload) => Object.assign(target, payload, { active: false, name: 'Wrong workflow' })
        }
    ];

    for (const testCase of cases) {
        const rootDir = createInventorySourceTree(t, testCase.configure);
        const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
        if (testCase.donor) targets.push(testCase.donor);
        const ids = new Map(targets.slice(0, inventory.length).map(workflow => [workflow.name, workflow.id]));
        const targetById = new Map(targets.map(workflow => [workflow.id, workflow]));

        await assert.rejects(deployV3WorkflowInventory({
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            rootDir,
            approvalEvidence: P4_APPROVAL,
            targetWorkflowIds: ids,
            fetchImpl: async (url, options = {}) => {
                const method = options.method || 'GET';
                if (method === 'GET' && url.includes('?')) {
                    return response({ data: targets, nextCursor: null });
                }
                const id = url.split('/').pop();
                const target = targetById.get(id);
                if (method === 'PUT') {
                    testCase.mutate(target, JSON.parse(options.body));
                    return response(target);
                }
                return response(target);
            }
        }), /does not match expected deployable content/i, testCase.label);
    }
});

test('P4 fails closed before PUT when a credential is missing or ambiguous', async t => {
    const inventory = getV3Inventory();
    const credentialWorkflowName = inventory[0][0];
    const rootDir = createInventorySourceTree(t, name => name === credentialWorkflowName ? {
        nodes: [{
            name: 'HTTP Request',
            credentials: { httpHeaderAuth: { id: 'source-id', name: 'Header Auth account 2' } }
        }]
    } : {});
    const ids = new Map(inventory.map(([name], index) => [name, `target-${index}`]));

    for (const credentialDonors of [[], [
        { id: 'donor-a', name: 'Donor A', nodes: [{ credentials: {
            httpHeaderAuth: { id: 'target-a', name: 'Header Auth account 2' }
        } }] },
        { id: 'donor-b', name: 'Donor B', nodes: [{ credentials: {
            httpHeaderAuth: { id: 'target-b', name: 'Header Auth account 2' }
        } }] }
    ]]) {
        const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
        targets.push(...credentialDonors);
        let putCalls = 0;

        await assert.rejects(deployV3WorkflowInventory({
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            rootDir,
            approvalEvidence: P4_APPROVAL,
            targetWorkflowIds: ids,
            fetchImpl: async (_url, options = {}) => {
                if (options.method === 'PUT') putCalls += 1;
                return response({ data: targets, nextCursor: null });
            }
        }), /(?:missing target|ambiguous) credential reference/i);
        assert.equal(putCalls, 0);
    }
});

test('P4 only PUTs an inactive empty inert P2 skeleton and verifies it stays inactive', async t => {
    const inventory = getV3Inventory();
    const rootDir = createInventorySourceTree(t);
    const ids = new Map(inventory.map(([name], index) => [name, `target-${index}`]));

    for (const overrides of [{ active: true }, { connections: { Existing: {} } }]) {
        const targets = inventory.map(([name], index) => workflowDetail(
            `target-${index}`,
            name,
            index === inventory.length - 1 ? overrides : {}
        ));
        let putCalls = 0;

        await assert.rejects(deployV3WorkflowInventory({
            apiUrl: 'https://unused.invalid',
            apiKey: 'test-key',
            rootDir,
            approvalEvidence: P4_APPROVAL,
            targetWorkflowIds: ids,
            fetchImpl: async (_url, options = {}) => {
                if (options.method === 'PUT') putCalls += 1;
                return response({ data: targets, nextCursor: null });
            }
        }), /inactive empty inert P2 skeleton/i);
        assert.equal(putCalls, 0);
    }

    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    let firstPut = true;
    await assert.rejects(deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        targetWorkflowIds: ids,
        fetchImpl: async (url, options = {}) => {
            if ((options.method || 'GET') === 'GET' && url.includes('?')) {
                return response({ data: targets, nextCursor: null });
            }
            const target = targets.find(workflow => workflow.id === url.split('/').pop());
            if (options.method === 'PUT') {
                firstPut = false;
                return response({});
            }
            return response({ ...target, active: firstPut ? false : true });
        }
    }), /became active after PUT/i);
});
