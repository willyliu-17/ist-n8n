const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    buildWorkflowIdMap,
    assertUniqueRequestedWorkflowNames,
    collectCredentialReferences,
    buildCredentialReferenceMap,
    remapCredentialReferences,
    remapExecuteWorkflowNodes,
    createWorkflowPayload,
    parseCreatedWorkflowId
} = require('./deploy-utils');
const {
    deployWorkflows,
    provisionV3WorkflowInventory,
    deployV3WorkflowInventory
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
        description: 'Workflow description',
        active: true,
        tags: [{ id: 'tag-id' }]
    };
    const remappedNodes = [{ name: 'Remapped node' }];

    assert.deepEqual(createWorkflowPayload(workflow, remappedNodes), {
        name: 'Workflow A',
        nodes: remappedNodes,
        connections: { A: {} },
        settings: { executionOrder: 'v1' },
        description: 'Workflow description'
    });
});

test('parseCreatedWorkflowId returns an ID and rejects a missing ID', () => {
    assert.equal(parseCreatedWorkflowId({ id: 'created-id' }), 'created-id');
    assert.throws(() => parseCreatedWorkflowId({ name: 'Workflow A' }), /missing an ID/);
});

function getV3Inventory() {
    return require('./stt-summary-v3-inventory').V3_WORKFLOW_INVENTORY;
}

const P2_APPROVAL = Object.freeze({ approved: true, gate: 'P2', reference: 'P2-approval-001' });
const P3_EVIDENCE = Object.freeze({ approved: true, gate: 'P3', reference: 'P3-schema-001' });
const P4_APPROVAL = Object.freeze({ approved: true, gate: 'P4', reference: 'P4-approval-001' });

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
        ['IST bot entry v3', 'workflows/ist_bot_entry_v3_IstBotEntryV3A01']
    ]);
    assert.ok(Object.isFrozen(getV3Inventory()));
    assert.ok(getV3Inventory().every(tuple => Object.isFrozen(tuple)));
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

test('P2 accepts the n8n executionOrder default returned after fresh skeleton creation', async () => {
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
                        settings: { executionOrder: 'v1' }
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
                settings: { executionOrder: 'v1' }
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
    ['non-inert', { settings: { saveExecutionProgress: true } }, /non-empty or non-inert/i]
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

test('P4 requires independent P4 approval, P3 schema evidence, and every P2 target ID before I/O', async () => {
    const inventory = getV3Inventory();
    const completeIds = new Map(inventory.map(([name], index) => [name, `target-${index}`]));
    const incompleteIds = new Map(completeIds);
    incompleteIds.delete(inventory[inventory.length - 1][0]);
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
        { p3SchemaEvidence: P3_EVIDENCE, targetWorkflowIds: completeIds },
        {
            approvalEvidence: { approved: false, gate: 'P4', reference: 'P4-denied' },
            p3SchemaEvidence: P3_EVIDENCE,
            targetWorkflowIds: completeIds
        },
        {
            approvalEvidence: { approved: true, gate: 'P2', reference: 'wrong-gate' },
            p3SchemaEvidence: P3_EVIDENCE,
            targetWorkflowIds: completeIds
        },
        {
            approvalEvidence: { approved: true, gate: 'P4', reference: '   ' },
            p3SchemaEvidence: P3_EVIDENCE,
            targetWorkflowIds: completeIds
        }
    ]) {
        await assert.rejects(
            deployV3WorkflowInventory({ ...options, ...invalid }),
            /explicit P4 approval evidence/i
        );
    }
    for (const p3SchemaEvidence of [
        undefined,
        { approved: false, gate: 'P3', reference: 'P3-denied' },
        { approved: true, gate: 'P4', reference: 'wrong-gate' },
        { approved: true, gate: 'P3', reference: '' }
    ]) {
        await assert.rejects(deployV3WorkflowInventory({
            ...options,
            approvalEvidence: P4_APPROVAL,
            p3SchemaEvidence,
            targetWorkflowIds: completeIds
        }), /explicit P3 schema evidence/i);
    }
    await assert.rejects(
        deployV3WorkflowInventory({
            ...options,
            approvalEvidence: P4_APPROVAL,
            p3SchemaEvidence: P3_EVIDENCE,
            targetWorkflowIds: incompleteIds
        }),
        /complete P2 target workflow IDs/i
    );
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
        p3SchemaEvidence: P3_EVIDENCE,
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
        p3SchemaEvidence: P3_EVIDENCE,
        targetWorkflowIds: ids,
        fetchImpl: async (_url, options = {}) => {
            if (options.method === 'PUT') putCalls += 1;
            return response({ data: targets, nextCursor: null });
        }
    }), /references unknown workflow "Unknown workflow"/i);
    assert.equal(putCalls, 0);
});

test('P4 deep-clones and remaps selectors and credentials before PUT, then confirms inactive', async t => {
    const inventory = getV3Inventory();
    const callerName = inventory[0][0];
    const childName = inventory[1][0];
    const rootDir = createInventorySourceTree(t, name => name === callerName ? {
        nodes: [{
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
        }]
    } : {});
    const targetWorkflows = inventory.map(([name], index) => workflowDetail(`target-${index}`, name));
    targetWorkflows.push({
        id: 'credential-donor',
        name: 'Credential donor',
        nodes: [{ credentials: {
            httpHeaderAuth: { id: 'target-header-auth-id', name: 'Header Auth account 2' }
        } }]
    });
    const ids = new Map(targetWorkflows.slice(0, inventory.length).map(workflow => [workflow.name, workflow.id]));
    const putPayloads = [];
    const methods = [];

    await deployV3WorkflowInventory({
        apiUrl: 'https://unused.invalid',
        apiKey: 'test-key',
        rootDir,
        approvalEvidence: P4_APPROVAL,
        p3SchemaEvidence: P3_EVIDENCE,
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
    assert.equal(methods.filter(method => method === 'POST').length, 0);
    assert.equal(methods.filter(method => method === 'PUT').length, inventory.length);
    assert.equal(
        methods.slice(methods.indexOf('PUT')).filter(method => method === 'GET').length,
        inventory.length * 2
    );
});

test('P4 treats exact deployed content as completed and accepts only safe executionOrder normalization', async t => {
    const inventory = getV3Inventory();
    const firstName = inventory[0][0];
    const rootDir = createInventorySourceTree(t, name => name === firstName ? {
        description: 'Required workflow description'
    } : {});
    const targets = inventory.map(([name], index) => workflowDetail(`target-${index}`, name, {
        nodes: [{ name: 'Source', type: 'n8n-nodes-base.noOp', parameters: {} }],
        settings: index === inventory.length - 1 ? { executionOrder: 'v1' } : {},
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
        p3SchemaEvidence: P3_EVIDENCE,
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
        p3SchemaEvidence: P3_EVIDENCE,
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
            p3SchemaEvidence: P3_EVIDENCE,
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
        p3SchemaEvidence: P3_EVIDENCE,
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
        p3SchemaEvidence: P3_EVIDENCE,
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
        p3SchemaEvidence: P3_EVIDENCE,
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
        p3SchemaEvidence: P3_EVIDENCE,
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
    }), /completed target.*diverged|does not match expected deployable content/i);
    assert.equal(putCalls, 0);
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
        p3SchemaEvidence: P3_EVIDENCE,
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
        p3SchemaEvidence: P3_EVIDENCE,
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
        p3SchemaEvidence: P3_EVIDENCE,
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
            p3SchemaEvidence: P3_EVIDENCE,
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
            p3SchemaEvidence: P3_EVIDENCE,
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
            p3SchemaEvidence: P3_EVIDENCE,
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
            p3SchemaEvidence: P3_EVIDENCE,
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
            p3SchemaEvidence: P3_EVIDENCE,
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
        p3SchemaEvidence: P3_EVIDENCE,
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
