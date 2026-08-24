const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowDir = path.resolve(__dirname, '..');
const workflow = JSON.parse(fs.readFileSync(path.join(workflowDir, 'workflow.json'), 'utf8'));
const maskCodePath = path.join(workflowDir, 'nodes', 'Mask_Error', 'jsCode.js');
const { SCHEMA_KEYS, maskErrorEnvelope, maskText } = require(maskCodePath);

function node(name) {
  const result = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(result, `Missing node: ${name}`);
  return result;
}

function targets(name, output = 0) {
  return (workflow.connections[name]?.main?.[output] || []).map(({ node: target }) => target);
}

function envelope(overrides = {}) {
  return {
    execution: { id: 'exec-123', lastNodeExecuted: 'Submit', error: { name: 'NodeApiError', statusCode: 503, message: 'failed' } },
    workflow: { name: 'STT: dispatch attempt v3' },
    ...overrides,
  };
}

function runPlan(rows, candidate = maskErrorEnvelope(envelope())) {
  const code = node('Plan Error Rows').parameters.jsCode;
  const items = candidate ? [candidate, ...rows] : [...rows];
  return Function('$input', code)({
    all: () => items.map((json) => ({ json })),
  });
}

function runVerification(name, rows) {
  return Function('$input', node(name).parameters.jsCode)({ all: () => rows.map((json) => ({ json })) });
}

test('masks URL queries, fragments, auth-like text, and callback credentials', () => {
  const text = maskText('GET https://example.test/a?token=abc#part Authorization: Bearer abc callbackToken: xyz password=hello');
  assert.doesNotMatch(text, /token=abc|#part|Bearer abc|callbackToken:\s*xyz|password=hello/i);
  assert.match(text, /https:\/\/example\.test\/a\[redacted\]/);
  assert.match(text, /Authorization=\[redacted\]|Authorization:\s*Bearer=\[redacted\]/i);
});

test('does not retain envelope headers, body, stack, or upstream response', () => {
  const result = maskErrorEnvelope(envelope({ headers: { authorization: 'secret' }, body: { callbackToken: 'secret' }, execution: { id: 'exec-123', error: { name: 'Error', message: 'bad', stack: 'secret', response: { body: 'secret' } } } }));
  assert.deepEqual(Object.keys(result), SCHEMA_KEYS);
  assert.doesNotMatch(JSON.stringify(result), /headers|stack|response|secret|callbackToken/i);
});

test('bounds text and normalizes control characters', () => {
  const result = maskErrorEnvelope(envelope({ execution: { id: 'exec-123', error: { name: 'Error', message: `a\u0000b\n${'x'.repeat(700)}` } } }));
  assert.ok(result.messageMasked.length <= 512);
  assert.doesNotMatch(result.messageMasked, /[\u0000-\u001f\u007f]/);
});

test('emits the exact primitive schema order', () => {
  const result = maskErrorEnvelope(envelope());
  assert.deepEqual(Object.keys(result), SCHEMA_KEYS);
  assert.ok(Object.values(result).every((value) => ['string', 'boolean'].includes(typeof value)));
});

test('derives bounded deterministic keys without an execution id or randomness', () => {
  const input = envelope({ execution: { lastNodeExecuted: 'Submit', error: { name: 'Error', message: 'same' } } });
  const first = maskErrorEnvelope(input, '2026-08-24T00:00:00.000Z');
  const second = maskErrorEnvelope(input, '2026-08-24T00:01:00.000Z');
  assert.equal(first.errorKey, second.errorKey);
  assert.match(first.errorKey, /^err:v1:[0-9a-f]{8}$/);
});

test('classifies retryability only from bounded status or error-name allowlists', () => {
  assert.equal(maskErrorEnvelope(envelope()).retryable, true);
  assert.equal(maskErrorEnvelope(envelope({ execution: { id: 'x', error: { name: 'TimeoutError', message: 'ignored' } } })).retryable, true);
  assert.equal(maskErrorEnvelope(envelope({ execution: { id: 'x', error: { name: 'Error', statusCode: 400, message: 'timeout words do not decide' } } })).retryable, false);
});

test('uses one inactive Error Trigger with UUIDs and no self-assignment or credentials', () => {
  const triggers = workflow.nodes.filter(({ type }) => type.toLowerCase().includes('trigger'));
  assert.equal(workflow.id, 'AutomationErrorV3A1');
  assert.equal(workflow.name, 'Automation: error handler v3');
  assert.equal(workflow.active, false);
  assert.equal(workflow.isArchived, false);
  assert.deepEqual(triggers.map(({ type }) => type), ['n8n-nodes-base.errorTrigger']);
  assert.ok(workflow.nodes.every(({ id }) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)));
  assert.equal(JSON.stringify(workflow).includes('credentials'), false);
  assert.equal(JSON.stringify(workflow).includes('errorWorkflow'), false);
});

test('uses only the authoritative table placeholder and exact ordered write schema', () => {
  const tables = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.dataTable');
  const writes = tables.filter(({ parameters }) => parameters.operation !== 'get');
  assert.ok(tables.every(({ parameters }) => parameters.dataTableId.value === 'automation_errors_v3' && parameters.dataTableId.mode === 'name'));
  for (const write of writes) {
    const expectedColumns = write.parameters.operation === 'insert'
      ? SCHEMA_KEYS
      : ['reconciliationStatus', 'canonicalRowID'];
    assert.deepEqual(Object.keys(write.parameters.columns.value), expectedColumns, write.name);
    assert.equal(write.parameters.matchType, 'allConditions', write.name);
    assert.equal(write.alwaysOutputData, true, write.name);
  }
});

test('reads all matching rows with zero-row continuation and verifies every write through Limit 1 then full reread', () => {
  const reads = workflow.nodes.filter(({ type, parameters }) => type === 'n8n-nodes-base.dataTable' && parameters.operation === 'get');
  assert.ok(reads.every(({ parameters, alwaysOutputData }) => parameters.returnAll === true && parameters.matchType === 'allConditions' && alwaysOutputData === true));
  for (const [write, limit, reread] of [
    ['Insert Pending Error', 'Limit Pending Insert', 'Re-read After Pending Insert'],
    ['Canonicalize Pending Error', 'Limit Pending Canonical', 'Re-read Pending Canonical'],
    ['Reconcile Error Rows', 'Limit Error Reconciliation', 'Re-read After Error Reconciliation'],
    ['Insert Duplicate Error', 'Limit Duplicate Insert', 'Re-read Duplicate Error'],
  ]) {
    assert.deepEqual(targets(write), [limit]);
    assert.equal(node(limit).parameters.maxItems, 1);
    assert.deepEqual(targets(limit), [reread]);
  }
});

test('workflow contains zero historical lookup or $( expressions', () => {
  const serialized = JSON.stringify(workflow);
  assert.equal(serialized.includes("$('"), false);
  assert.equal(serialized.includes('$('), false);
});

test('error candidate direct carrier and same-key raw rows are supplied through 2-input append Merge', () => {
  const merge = node('Merge Error Candidate And Rows');
  assert.equal(merge.type, 'n8n-nodes-base.merge');
  assert.equal(merge.parameters.mode, 'append');
  assert.equal(merge.parameters.numberInputs, 2);

  const maskTargets = workflow.connections['Mask Error']?.main?.[0] || [];
  const mergeConn0 = maskTargets.find((t) => t.node === merge.name);
  const readConn = maskTargets.find((t) => t.node === 'Read All Error Rows');
  assert.ok(mergeConn0, 'Mask Error must target Merge Error Candidate And Rows');
  assert.equal(mergeConn0.index, 0, 'Mask Error must connect to Merge input 0');
  assert.ok(readConn, 'Mask Error must target Read All Error Rows');
  assert.equal(readConn.index, 0, 'Mask Error must connect to Read All Error Rows input 0');

  const readTargets = workflow.connections['Read All Error Rows']?.main?.[0] || [];
  const mergeConn1 = readTargets.find((t) => t.node === merge.name);
  assert.ok(mergeConn1, 'Read All Error Rows must target Merge Error Candidate And Rows');
  assert.equal(mergeConn1.index, 1, 'Read All Error Rows must connect to Merge input 1');

  assert.deepEqual(targets(merge.name), ['Plan Error Rows']);
});

test('fails closed when candidate is absent, multiple candidates are inconsistent, or same-key raw rows drift', () => {
  const candidate = maskErrorEnvelope(envelope());
  const canonical = { ...candidate, id: 'row-z', createdAt: '2026-08-24T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-z' };

  // Candidate absent fails closed
  assert.throws(() => runPlan([canonical], null), /missing error candidate/);
  assert.throws(() => runPlan([], null), /missing error candidate/);

  // Multiple candidates inconsistent fail closed
  const inconsistentCandidate = { ...candidate, errorKey: 'err:v1:different' };
  assert.throws(
    () => Function('$input', node('Plan Error Rows').parameters.jsCode)({
      all: () => [{ json: candidate }, { json: inconsistentCandidate }],
    }),
    /multiple inconsistent error candidates/,
  );

  // Same-key raw rows reread mismatch / drift fails closed
  const driftedRow = { ...canonical, errorKey: 'err:v1:otherkey' };
  assert.throws(() => runPlan([driftedRow], candidate), /immutable masked error payload drift/);
});

test('plans absent, duplicate, concurrent-canonical, immutable-drift, and partial-CAS cases fail closed', () => {
  const candidate = maskErrorEnvelope(envelope());
  assert.equal(runPlan([], candidate)[0].json.action, 'insert_pending');

  const canonical = { ...candidate, id: 'row-z', createdAt: '2026-08-24T00:00:00.000Z', reconciliationStatus: 'canonical', canonicalRowID: 'row-z' };
  assert.deepEqual(runPlan([canonical], candidate)[0].json, { ...candidate, action: 'insert_duplicate', canonicalRowID: 'row-z' });

  const concurrent = [
    { ...canonical, id: 'row-b', canonicalRowID: 'row-b' },
    { ...canonical, id: 'row-a', canonicalRowID: 'row-a' },
  ];
  const reconciliation = runPlan(concurrent, candidate).map(({ json }) => json);
  assert.equal(reconciliation.some(({ id }) => id === 'row-a'), false);
  assert.ok(reconciliation.some(({ id, desiredReconciliationStatus, desiredCanonicalRowID }) => id === 'row-b' && desiredReconciliationStatus === 'duplicate' && desiredCanonicalRowID === 'row-a'));

  assert.throws(() => runPlan([{ ...canonical, messageMasked: 'changed' }], candidate), /immutable masked error payload drift/);
  assert.throws(() => runVerification('Verify Error Reconciliation', [{ ...canonical, reconciliationStatus: 'duplicate', canonicalRowID: '' }]), /verification failed/);
  assert.throws(() => runVerification('Verify Duplicate Error', [{ ...canonical, reconciliationStatus: 'duplicate', canonicalRowID: '' }]), /verification failed/);
});

test('does not retain raw payload fields, use live endpoints, or create side-effect leases', () => {
  const serialized = JSON.stringify(workflow);
  const maskCode = fs.readFileSync(maskCodePath, 'utf8');
  assert.doesNotMatch(serialized, /webhook|httpRequest|scheduleTrigger|manualTrigger|leaseOwner|leaseUntilIso/i);
  assert.doesNotMatch(maskCode, /JSON\.stringify\(envelope\)|headers|\.body|\.stack|response\.body/);
  assert.doesNotMatch(maskCode, /require\s*\(|console\./);
});

test('externalizes the masking code and retains no secret fixture values', () => {
  const externalCodeNodes = workflow.nodes.filter(({ type, parameters }) => type === 'n8n-nodes-base.code' && parameters.jsCode.includes('__EXTERNAL_FILE__://'));
  assert.equal(node('Mask Error').parameters.jsCode, '__EXTERNAL_FILE__://nodes/Mask_Error/jsCode.js');
  assert.equal(externalCodeNodes.length, 1);
  assert.doesNotMatch(JSON.stringify(workflow), /sk_live|AKIA|ghp_/i);
});

test('absent error canonicalization does not connect to Insert Duplicate Error and terminates cleanly', () => {
  const pendingVerifierTargets = targets('Verify Pending Error Canonical');
  assert.deepEqual(pendingVerifierTargets, [], 'Verify Pending Error Canonical must terminate with no duplicate write');
  assert.equal(targets('Re-read Pending Canonical')[0], 'Verify Pending Error Canonical');
  const insertDuplicatePredecessors = Object.entries(workflow.connections).filter(([, conns]) =>
    conns.main?.some((branch) => branch.some((target) => target.node === 'Insert Duplicate Error'))
  ).map(([source]) => source);
  assert.ok(!insertDuplicatePredecessors.includes('Verify Pending Error Canonical'));
  assert.ok(!insertDuplicatePredecessors.includes('Re-read Pending Canonical'));
  assert.deepEqual(insertDuplicatePredecessors.sort(), ['Needs Error Reconciliation', 'Verify Error Reconciliation'].sort());
});

test('absent error flow produces only pending insert and canonical update with zero duplicate writes', () => {
  const candidate = maskErrorEnvelope(envelope());
  const plan = runPlan([], candidate);
  assert.equal(plan[0].json.action, 'insert_pending');
  // Plan Pending Canonical on newly inserted pending row
  const pendingRow = { ...candidate, id: 'row-1', createdAt: '2026-08-24T00:00:00.000Z', reconciliationStatus: 'pending', canonicalRowID: '' };
  const canonicalPlan = Function('$input', node('Plan Pending Canonical').parameters.jsCode)({
    all: () => [{ json: pendingRow }],
  });
  assert.equal(canonicalPlan[0].json.desiredReconciliationStatus, 'canonical');
  assert.equal(canonicalPlan[0].json.desiredCanonicalRowID, 'row-1');
  // Verify Pending Error Canonical verifies the canonicalized row
  const canonicalRow = { ...pendingRow, reconciliationStatus: 'canonical', canonicalRowID: 'row-1' };
  const verified = runVerification('Verify Pending Error Canonical', [canonicalRow]);
  assert.deepEqual(verified, [{ json: { canonicalRowID: 'row-1' } }]);
});
