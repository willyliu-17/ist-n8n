const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { buildWorkflow, resolveExternalFiles } = require('./utils');
const {
    buildWorkflowIdMap,
    assertUniqueRequestedWorkflowNames,
    buildRequestedSourceIdNameMap,
    buildWorkflowNameByIdMap,
    collectCredentialReferences,
    buildCredentialReferenceMap,
    remapCredentialReferences,
    collectDataTableReferences,
    remapDataTableReferences,
    assertDataTableTargetIds,
    collectRequiredWorkflowNames,
    validateExecuteWorkflowSelectors,
    remapExecuteWorkflowNodes,
    createWorkflowPayload,
    parseCreatedWorkflowId
} = require('./deploy-utils');
const { V3_WORKFLOW_INVENTORY, V3_DATA_TABLE_NAMES } = require('./stt-summary-v3-inventory');

const P3_ARTIFACT_VERSION = 1;
const CANONICAL_DATA_TABLE_SCHEMA_PATH = path.resolve(
    __dirname,
    '..',
    'workflows/automation_provision_state_v3_AutomationProvV3A1/nodes/State_Schema/schema.json'
);
const DATA_TABLE_SYSTEM_COLUMNS = new Set(['id', 'createdAt', 'updatedAt']);
const DATA_TABLE_PRIMITIVE_TYPES = new Set(['boolean', 'number', 'string']);
const P3_ARTIFACT_MAX_BYTES = 12 * 1024;
const METADATA_MAX_LENGTH = 256;
const REFERENCE_MAX_LENGTH = 4096;
const TARGET_ID_MAX_LENGTH = 4096;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

function buildRequestedWorkflows(files) {
    return files.map(file => {
        const filePath = path.resolve(file);
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        try {
            if (fs.statSync(filePath).isDirectory()) {
                return buildWorkflow(filePath);
            }
            return resolveExternalFiles(JSON.parse(fs.readFileSync(filePath, 'utf8')), path.dirname(filePath));
        } catch (err) {
            throw new Error(`Error building workflow from ${filePath}: ${err.message}`);
        }
    });
}

async function responseError(response) {
    const body = await response.text();
    if (!body) return `${response.status} ${response.statusText}`;

    try {
        return JSON.stringify(JSON.parse(body));
    } catch {
        return body;
    }
}

async function fetchTargetWorkflows(apiUrl, apiKey, fetchImpl) {
    const workflows = [];
    let cursor;

    do {
        const query = new URLSearchParams({ limit: '250' });
        if (cursor) query.set('cursor', cursor);

        const response = await fetchImpl(`${apiUrl}/api/v1/workflows?${query}`, {
            headers: { 'X-N8N-API-KEY': apiKey }
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch workflows from target: ${await responseError(response)}`);
        }

        const page = await response.json();
        workflows.push(...(page.data || []));
        cursor = page.nextCursor;
    } while (cursor);

    return workflows;
}

async function fetchTargetWorkflow(apiUrl, apiKey, id, fetchImpl) {
    const response = await fetchImpl(`${apiUrl}/api/v1/workflows/${id}`, {
        headers: { 'X-N8N-API-KEY': apiKey }
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch target workflow ${id}: ${await responseError(response)}`);
    }
    return response.json();
}

function isEmptyObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

function isInertSettings(value) {
    if (
        !value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        return false;
    }

    const keys = Object.keys(value);
    return keys.length === 0 || (
        keys.length === 1 &&
        keys[0] === 'executionOrder' &&
        value.executionOrder === 'v1'
    );
}

function assertInactiveInertSkeleton(workflow, expectedName) {
    if (!workflow || workflow.id === undefined || workflow.id === null || workflow.id === '') {
        throw new Error(`Target workflow "${expectedName}" is missing an ID`);
    }
    if (workflow.name !== expectedName) {
        throw new Error(`Target workflow ID "${workflow.id}" does not have exact name "${expectedName}"`);
    }
    if (workflow.active !== false) {
        throw new Error(`Refusing active workflow exactly named "${expectedName}"`);
    }
    if (
        !Array.isArray(workflow.nodes) || workflow.nodes.length !== 0 ||
        !isEmptyObject(workflow.connections) ||
        !isInertSettings(workflow.settings)
    ) {
        throw new Error(`Workflow "${expectedName}" is non-empty or non-inert`);
    }
}

function exactInventoryMatches(targetWorkflows, name) {
    return targetWorkflows.filter(workflow => workflow.name === name);
}

function assertGateEvidence(evidence, gate, label) {
    if (
        !evidence || evidence.approved !== true || evidence.gate !== gate ||
        typeof evidence.reference !== 'string' || !evidence.reference ||
        evidence.reference !== evidence.reference.trim() ||
        evidence.reference.length > REFERENCE_MAX_LENGTH ||
        CONTROL_CHARACTER_PATTERN.test(evidence.reference)
    ) {
        throw new Error(`Explicit ${label} evidence is required`);
    }
}

function isPlainObject(value) {
    return (
        value && typeof value === 'object' && !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
    );
}

function hasExactKeys(value, expectedKeys) {
    if (!isPlainObject(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (
        keys.length !== expectedKeys.length ||
        keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))
    ) {
        return false;
    }
    return expectedKeys.every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
    });
}

function assertBoundedString(value, label, maxLength = METADATA_MAX_LENGTH) {
    if (
        typeof value !== 'string' || !value || value !== value.trim() ||
        value.length > maxLength || CONTROL_CHARACTER_PATTERN.test(value)
    ) {
        throw new Error(`${label} must be a nonempty, trimmed, bounded string without control characters`);
    }
}

function assertPlainJsonArray(value, label, maxLength) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`${label} must be a plain JSON array`);
    }
    if (maxLength !== undefined && value.length > maxLength) {
        throw new Error(`${label} exceeds the maximum array length`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || ownKeys.some(key => (
        key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))
    ))) {
        throw new Error(`${label} must not contain sparse entries or extra properties`);
    }
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new Error(`${label} must contain dense data entries only`);
        }
    }
}

function canonicalSerialize(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalSerialize).join(',')}]`;
    }
    if (isPlainObject(value)) {
        return `{${Object.keys(value).sort().map(key => (
            `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`
        )).join(',')}}`;
    }
    if (
        value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
    ) {
        return JSON.stringify(value);
    }
    throw new Error('Canonical serialization requires validated JSON data');
}

function sha256(value) {
    return crypto.createHash('sha256').update(canonicalSerialize(value)).digest('hex');
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value)) deepFreeze(nested);
    return Object.freeze(value);
}

function normalizeColumns(columns, tableName, label, { expectedLength } = {}) {
    if (!Array.isArray(columns) || Object.getPrototypeOf(columns) !== Array.prototype) {
        throw new Error(`${label} Data Table "${tableName}" custom columns must be an array`);
    }
    if (expectedLength !== undefined && columns.length !== expectedLength) {
        throw new Error(
            `${label} Data Table "${tableName}" has ${columns.length < expectedLength ? 'missing' : 'extra'} custom columns`
        );
    }
    assertPlainJsonArray(columns, `${label} Data Table "${tableName}" custom columns`, 256);

    const normalized = [];
    const seenNames = new Set();
    for (let index = 0; index < columns.length; index += 1) {
        if (!Object.hasOwn(columns, index)) {
            throw new Error(`${label} Data Table "${tableName}" has sparse custom column metadata`);
        }
        const column = columns[index];
        if (
            !hasExactKeys(column, ['name', 'type']) ||
            typeof column.name !== 'string' || !column.name ||
            typeof column.type !== 'string' || !column.type
        ) {
            throw new Error(`${label} Data Table "${tableName}" has invalid custom column metadata`);
        }
        assertBoundedString(column.name, `${label} Data Table "${tableName}" custom column name`);
        assertBoundedString(column.type, `${label} Data Table "${tableName}" custom column type`);
        if (DATA_TABLE_SYSTEM_COLUMNS.has(column.name)) {
            throw new Error(`${label} Data Table "${tableName}" has system column collision "${column.name}"`);
        }
        if (seenNames.has(column.name)) {
            throw new Error(`${label} Data Table "${tableName}" has duplicate custom column "${column.name}"`);
        }
        seenNames.add(column.name);
        if (!DATA_TABLE_PRIMITIVE_TYPES.has(column.type)) {
            throw new Error(`${label} Data Table "${tableName}" has invalid primitive type "${column.type}"`);
        }
        normalized.push({ name: column.name, type: column.type });
    }
    return normalized;
}

function assertExactColumns(actual, expected, tableName, label, lengthFirst = false) {
    const columns = normalizeColumns(
        actual,
        tableName,
        label,
        lengthFirst ? { expectedLength: expected.length } : undefined
    );
    if (columns.length < expected.length) {
        throw new Error(`${label} Data Table "${tableName}" is missing canonical custom columns`);
    }
    if (columns.length > expected.length) {
        throw new Error(`${label} Data Table "${tableName}" has extra custom columns`);
    }

    for (let index = 0; index < expected.length; index += 1) {
        if (columns[index].name !== expected[index].name) {
            throw new Error(`${label} Data Table "${tableName}" custom column order or name mismatch at index ${index}`);
        }
        if (columns[index].type !== expected[index].type) {
            throw new Error(
                `${label} Data Table "${tableName}" custom column "${columns[index].name}" type mismatch`
            );
        }
    }
    return columns;
}

function loadCanonicalDataTableSchema() {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(CANONICAL_DATA_TABLE_SCHEMA_PATH, 'utf8'));
    } catch (error) {
        throw new Error(`Failed to load canonical Data Table schema: ${error.message}`);
    }
    if (!isPlainObject(parsed) || !isDeepStrictEqual(Object.keys(parsed), V3_DATA_TABLE_NAMES)) {
        throw new Error('Canonical Data Table schema must contain the four authoritative tables in order');
    }

    const schema = {};
    for (const tableName of V3_DATA_TABLE_NAMES) {
        schema[tableName] = normalizeColumns(parsed[tableName], tableName, 'Canonical');
    }
    return schema;
}

function unsignedP3Artifact(artifact) {
    return {
        version: artifact.version,
        gate: artifact.gate,
        approvalReference: artifact.approvalReference,
        canonicalSchemaDigest: artifact.canonicalSchemaDigest,
        tables: artifact.tables
    };
}

async function inspectV3DataTableInventory({ approvalEvidence, tables, readTableById }) {
    assertGateEvidence(approvalEvidence, 'P3', 'P3 schema');
    if (!Array.isArray(tables) || typeof readTableById !== 'function') {
        throw new Error('P3 normalized read-only Data Table metadata array and read adapter are required');
    }
    assertPlainJsonArray(tables, 'P3 normalized Data Table metadata', 100);
    for (const table of tables) {
        if (!hasExactKeys(table, ['id', 'name'])) {
            throw new Error('P3 inspector accepts normalized Data Table metadata with exact id and name fields only');
        }
        assertBoundedString(table.id, 'P3 normalized Data Table ID', TARGET_ID_MAX_LENGTH);
        assertBoundedString(table.name, 'P3 normalized Data Table name');
    }

    const canonicalSchema = loadCanonicalDataTableSchema();
    const artifactTables = [];
    const seenIds = new Set();
    for (const tableName of V3_DATA_TABLE_NAMES) {
        const matches = tables.filter(table => table?.name === tableName);
        if (matches.length === 0) {
            throw new Error(`Missing target Data Table exactly named "${tableName}"`);
        }
        if (matches.length > 1) {
            throw new Error(`Found multiple target Data Tables exactly named "${tableName}"`);
        }
        const id = matches[0].id;
        if (typeof id !== 'string' || !id.trim()) {
            throw new Error(`Target Data Table "${tableName}" has an invalid ID`);
        }
        if (seenIds.has(id)) {
            throw new Error(`P3 Data Table target ID "${id}" maps to multiple authoritative names`);
        }
        seenIds.add(id);
        const readback = await readTableById(id);
        if (!hasExactKeys(readback, ['id', 'name', 'columns'])) {
            throw new Error(`P3 normalized Data Table readback metadata is required for ID "${id}"`);
        }
        if (readback.id !== id || readback.name !== tableName) {
            throw new Error(`Target Data Table ID "${id}" readback name mismatch for "${tableName}"`);
        }
        artifactTables.push({
            name: tableName,
            id,
            columns: assertExactColumns(readback.columns, canonicalSchema[tableName], tableName, 'Target')
        });
    }

    const artifact = {
        version: P3_ARTIFACT_VERSION,
        gate: 'P3',
        approvalReference: approvalEvidence.reference,
        canonicalSchemaDigest: sha256(canonicalSchema),
        tables: artifactTables
    };
    artifact.artifactDigest = sha256(artifact);
    validateP3Artifact(artifact);
    return artifact;
}

function validateP3Artifact(p3Artifact) {
    const expectedKeys = [
        'version',
        'gate',
        'approvalReference',
        'canonicalSchemaDigest',
        'tables',
        'artifactDigest'
    ];
    if (!hasExactKeys(p3Artifact, expectedKeys)) {
        throw new Error('Invalid P3 artifact shape');
    }
    if (!Number.isInteger(p3Artifact.version) || p3Artifact.version !== P3_ARTIFACT_VERSION) {
        throw new Error('Invalid P3 artifact version');
    }
    if (p3Artifact.gate !== 'P3') {
        throw new Error('Invalid P3 artifact gate');
    }
    assertBoundedString(p3Artifact.approvalReference, 'Invalid P3 artifact approval reference', REFERENCE_MAX_LENGTH);
    if (!/^[a-f0-9]{64}$/.test(p3Artifact.canonicalSchemaDigest)) {
        throw new Error('Invalid P3 artifact canonical schema digest');
    }
    if (!/^[a-f0-9]{64}$/.test(p3Artifact.artifactDigest)) {
        throw new Error('Invalid P3 artifact digest');
    }

    if (
        !Array.isArray(p3Artifact.tables) ||
        Object.getPrototypeOf(p3Artifact.tables) !== Array.prototype ||
        p3Artifact.tables.length !== V3_DATA_TABLE_NAMES.length
    ) {
        throw new Error('Invalid P3 artifact tables');
    }
    assertPlainJsonArray(p3Artifact.tables, 'P3 artifact tables', V3_DATA_TABLE_NAMES.length);

    const ids = new Set();
    for (let index = 0; index < V3_DATA_TABLE_NAMES.length; index += 1) {
        if (!Object.hasOwn(p3Artifact.tables, index)) {
            throw new Error(`Invalid P3 artifact missing table at index ${index}`);
        }
        const tableName = V3_DATA_TABLE_NAMES[index];
        const table = p3Artifact.tables[index];
        if (!hasExactKeys(table, ['name', 'id', 'columns'])) {
            throw new Error(`Invalid P3 artifact table shape at index ${index}`);
        }
        if (table.name !== tableName) {
            throw new Error(`Invalid P3 artifact table order or name at index ${index}`);
        }
        assertBoundedString(table.id, `Invalid P3 artifact target ID for "${tableName}"`, TARGET_ID_MAX_LENGTH);
        if (ids.has(table.id)) {
            throw new Error(`Invalid P3 artifact duplicate target ID "${table.id}"`);
        }
        ids.add(table.id);
    }

    const canonicalSchema = loadCanonicalDataTableSchema();
    if (p3Artifact.canonicalSchemaDigest !== sha256(canonicalSchema)) {
        throw new Error('P3 artifact canonical schema digest does not match the current schema');
    }
    const entries = [];
    for (let index = 0; index < V3_DATA_TABLE_NAMES.length; index += 1) {
        const tableName = V3_DATA_TABLE_NAMES[index];
        const table = p3Artifact.tables[index];
        assertExactColumns(table.columns, canonicalSchema[tableName], tableName, 'P3 artifact', true);
        entries.push([tableName, table.id]);
    }

    const artifactBytes = Buffer.byteLength(JSON.stringify(p3Artifact), 'utf8');
    if (artifactBytes > P3_ARTIFACT_MAX_BYTES) {
        throw new Error(`P3 artifact exceeds the ${P3_ARTIFACT_MAX_BYTES}-byte limit`);
    }

    if (p3Artifact.artifactDigest !== sha256(unsignedP3Artifact(p3Artifact))) {
        throw new Error('P3 artifact digest mismatch');
    }
    deepFreeze(p3Artifact);
    return new Map(entries);
}

function assertSelectedInventory(targetWorkflows, workflowIds) {
    for (const [name] of V3_WORKFLOW_INVENTORY) {
        const matches = exactInventoryMatches(targetWorkflows, name);
        if (matches.length > 1) {
            throw new Error(`Found multiple workflows exactly named "${name}" on the target server`);
        }
        if (workflowIds.has(name)) {
            if (matches.length !== 1 || matches[0].id !== workflowIds.get(name)) {
                throw new Error(`Target workflow "${name}" no longer matches selected ID "${workflowIds.get(name)}"`);
            }
        } else if (matches.length !== 0) {
            throw new Error(`Workflow "${name}" appeared while P2 inventory creation was in progress`);
        }
    }
}

async function provisionV3WorkflowInventory({
    apiUrl,
    apiKey,
    approvalEvidence,
    fetchImpl = globalThis.fetch
}) {
    assertGateEvidence(approvalEvidence, 'P2', 'P2 approval');

    const workflowIds = new Map();
    const missingNames = [];
    const createdWorkflowIds = [];

    try {
        const targetWorkflows = await fetchTargetWorkflows(apiUrl, apiKey, fetchImpl);
        for (const [name] of V3_WORKFLOW_INVENTORY) {
            const matches = exactInventoryMatches(targetWorkflows, name);
            if (matches.length > 1) {
                throw new Error(`Found multiple workflows exactly named "${name}" on the target server`);
            }
            if (matches.length === 0) {
                missingNames.push(name);
                continue;
            }

            const detail = await fetchTargetWorkflow(apiUrl, apiKey, matches[0].id, fetchImpl);
            assertInactiveInertSkeleton(detail, name);
            workflowIds.set(name, detail.id);
        }

        for (const name of missingNames) {
            const skeleton = { name, nodes: [], connections: {}, settings: {} };
            const response = await fetchImpl(`${apiUrl}/api/v1/workflows`, {
                method: 'POST',
                headers: {
                    'X-N8N-API-KEY': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(skeleton)
            });
            if (!response.ok) {
                throw new Error(`Failed to create inert skeleton "${name}": ${await responseError(response)}`);
            }

            const id = parseCreatedWorkflowId(await response.json());
            createdWorkflowIds.push(id);
            const detail = await fetchTargetWorkflow(apiUrl, apiKey, id, fetchImpl);
            assertInactiveInertSkeleton(detail, name);
            workflowIds.set(name, id);

            const refreshedWorkflows = await fetchTargetWorkflows(apiUrl, apiKey, fetchImpl);
            assertSelectedInventory(refreshedWorkflows, workflowIds);
        }

        return new Map(V3_WORKFLOW_INVENTORY.map(([name]) => [name, workflowIds.get(name)]));
    } catch (error) {
        error.createdWorkflowIds = [...createdWorkflowIds];
        throw error;
    }
}

function assertP4Inputs(approvalEvidence, p3Artifact, targetWorkflowIds) {
    if (!hasExactKeys(approvalEvidence, ['approved', 'gate', 'reference', 'approvedP3ArtifactDigest'])) {
        throw new Error('Explicit P4 approval evidence with an approved P3 artifact digest is required');
    }
    assertGateEvidence(approvalEvidence, 'P4', 'P4 approval');
    if (!/^[a-f0-9]{64}$/.test(approvalEvidence.approvedP3ArtifactDigest || '')) {
        throw new Error('Explicit P4 approval evidence requires a lowercase approved P3 artifact digest');
    }
    if (
        !hasExactKeys(p3Artifact, [
            'version',
            'gate',
            'approvalReference',
            'canonicalSchemaDigest',
            'tables',
            'artifactDigest'
        ]) ||
        approvalEvidence.approvedP3ArtifactDigest !== p3Artifact.artifactDigest
    ) {
        throw new Error('Approved P3 artifact digest does not match the supplied P3 artifact');
    }
    const targetDataTableIds = validateP3Artifact(p3Artifact);
    if (!(targetWorkflowIds instanceof Map)) {
        throw new Error('Complete P2 target workflow IDs are required');
    }
    for (const [name] of V3_WORKFLOW_INVENTORY) {
        const id = targetWorkflowIds.get(name);
        if (typeof id !== 'string' || !id) {
            throw new Error(`Complete P2 target workflow IDs are required; missing "${name}"`);
        }
    }
    return targetDataTableIds;
}

function validateP2TargetIdentity(targetWorkflows, targetWorkflowIds) {
    const targetsByName = new Map();
    for (const [name] of V3_WORKFLOW_INVENTORY) {
        const matches = exactInventoryMatches(targetWorkflows, name);
        if (matches.length !== 1 || matches[0].id !== targetWorkflowIds.get(name)) {
            throw new Error(`P2 target workflow "${name}" is missing or does not match its approved ID`);
        }
        if (matches[0].active !== false) {
            throw new Error(
                `P4 requires an inactive empty inert P2 skeleton or inactive expected content for "${name}"`
            );
        }
        targetsByName.set(name, matches[0]);
    }
    return targetsByName;
}

function isInactiveInertSkeleton(workflow, expectedName) {
    try {
        assertInactiveInertSkeleton(workflow, expectedName);
        return true;
    } catch {
        return false;
    }
}

function settingsMatchExpected(actual, expected) {
    if (isDeepStrictEqual(actual, expected)) return true;
    if (
        !actual || typeof actual !== 'object' || Array.isArray(actual) ||
        !expected || typeof expected !== 'object' || Array.isArray(expected) ||
        Object.getPrototypeOf(actual) !== Object.prototype ||
        Object.getPrototypeOf(expected) !== Object.prototype ||
        Object.prototype.hasOwnProperty.call(expected, 'executionOrder')
    ) {
        return false;
    }
    return isDeepStrictEqual(actual, { ...expected, executionOrder: 'v1' });
}

function matchesExpectedDeployableContent(workflow, expectedPayload) {
    if (
        workflow.name !== expectedPayload.name ||
        !isDeepStrictEqual(workflow.nodes, expectedPayload.nodes) ||
        !isDeepStrictEqual(workflow.connections, expectedPayload.connections) ||
        !settingsMatchExpected(workflow.settings, expectedPayload.settings)
    ) {
        return false;
    }

    const targetDescription = workflow.description == null ? null : workflow.description;
    const expectedDescription = expectedPayload.description == null ? null : expectedPayload.description;
    return isDeepStrictEqual(targetDescription, expectedDescription);
}

function addP4RecoveryMetadata(error, deployments, completedWorkflowIds, failedWorkflowName) {
    const completedIds = new Set(completedWorkflowIds);
    error.completedWorkflowIds = [...completedWorkflowIds];
    error.pendingWorkflowIds = deployments
        .filter(deployment => !completedIds.has(deployment.id))
        .map(deployment => deployment.id);
    if (failedWorkflowName) {
        error.failedWorkflowName = failedWorkflowName;
        error.failedWorkflowId = deployments.find(
            deployment => deployment.payload.name === failedWorkflowName
        )?.id;
    }
    return error;
}

function buildV3DeploymentPlan(
    workflows,
    targetWorkflows,
    targetWorkflowIds,
    targetDataTableIds,
    sourceWorkflowNames,
    requiredCredentialReferences
) {
    const targetsByName = validateP2TargetIdentity(targetWorkflows, targetWorkflowIds);
    const targetWorkflowNames = buildWorkflowNameByIdMap(targetWorkflows);
    const requiredWorkflowNames = collectRequiredWorkflowNames(workflows);
    const selectorWorkflowIds = buildWorkflowIdMap(targetWorkflows, requiredWorkflowNames);
    for (const [name, id] of targetWorkflowIds) {
        if (selectorWorkflowIds.get(name) !== id) {
            throw new Error(`P4 selector authority does not match the approved P2 target ID for "${name}"`);
        }
    }
    validateExecuteWorkflowSelectors(
        workflows,
        selectorWorkflowIds,
        sourceWorkflowNames,
        targetWorkflowNames
    );
    const credentialIds = buildCredentialReferenceMap(targetWorkflows, requiredCredentialReferences);
    const deployments = workflows.map(workflow => {
        const clonedWorkflow = structuredClone(workflow);
        const tableRemappedNodes = remapDataTableReferences(clonedWorkflow.nodes, targetDataTableIds);
        const selectorRemappedNodes = remapExecuteWorkflowNodes(
            tableRemappedNodes,
            selectorWorkflowIds,
            sourceWorkflowNames,
            targetWorkflowNames
        );
        const nodes = remapCredentialReferences(selectorRemappedNodes, credentialIds);
        return {
            id: targetWorkflowIds.get(workflow.name),
            payload: createWorkflowPayload(clonedWorkflow, nodes)
        };
    });

    return { targetsByName, targetDataTableIds, credentialIds, deployments };
}

function classifyV3DeploymentPlan(plan) {
    return plan.deployments.map(deployment => {
        const target = plan.targetsByName.get(deployment.payload.name);
        if (matchesExpectedDeployableContent(target, deployment.payload)) return 'completed';
        if (isInactiveInertSkeleton(target, deployment.payload.name)) return 'pending';
        throw new Error(
            `P4 target "${deployment.payload.name}" is neither an inactive empty inert P2 skeleton ` +
            'nor expected deployable content'
        );
    });
}

function comparableV3Plan(plan, classifications) {
    return {
        credentialIds: plan.credentialIds,
        targetDataTableIds: plan.targetDataTableIds,
        deployments: plan.deployments,
        ...(classifications ? { classifications } : {})
    };
}

async function deployV3WorkflowInventory({
    apiUrl,
    apiKey,
    approvalEvidence,
    p3Artifact,
    targetWorkflowIds,
    rootDir = path.resolve(__dirname, '..'),
    fetchImpl = globalThis.fetch
}) {
    const targetDataTableIds = assertP4Inputs(approvalEvidence, p3Artifact, targetWorkflowIds);

    const files = V3_WORKFLOW_INVENTORY.map(([, relativePath]) => path.resolve(rootDir, relativePath));
    const workflows = buildRequestedWorkflows(files);
    assertUniqueRequestedWorkflowNames(workflows);
    for (let index = 0; index < V3_WORKFLOW_INVENTORY.length; index += 1) {
        if (workflows[index].name !== V3_WORKFLOW_INVENTORY[index][0]) {
            throw new Error(`Inventory workflow name mismatch at "${V3_WORKFLOW_INVENTORY[index][1]}"`);
        }
    }

    const requiredCredentialReferences = collectCredentialReferences(workflows);
    collectDataTableReferences(workflows);
    const sourceWorkflowNames = buildRequestedSourceIdNameMap(workflows);
    const initialTargetWorkflows = await fetchTargetWorkflows(apiUrl, apiKey, fetchImpl);
    const initialPlan = buildV3DeploymentPlan(
        workflows,
        initialTargetWorkflows,
        targetWorkflowIds,
        targetDataTableIds,
        sourceWorkflowNames,
        requiredCredentialReferences
    );
    const initialClassifications = classifyV3DeploymentPlan(initialPlan);

    let plan;
    let classifications;
    try {
        // n8n provides no snapshot token for this list. Replanning narrows authority
        // drift before mutation, while the final rebuild only detects later drift.
        const latestTargetWorkflows = await fetchTargetWorkflows(apiUrl, apiKey, fetchImpl);
        plan = buildV3DeploymentPlan(
            workflows,
            latestTargetWorkflows,
            targetWorkflowIds,
            targetDataTableIds,
            sourceWorkflowNames,
            requiredCredentialReferences
        );
        classifications = classifyV3DeploymentPlan(plan);
        if (!isDeepStrictEqual(
            comparableV3Plan(initialPlan, initialClassifications),
            comparableV3Plan(plan, classifications)
        )) {
            throw new Error('P4 target authority or deployment plan drifted before the first mutation');
        }
    } catch (error) {
        throw addP4RecoveryMetadata(error, initialPlan.deployments, []);
    }

    const completedWorkflowIds = [];
    const completedDeployments = [];
    const pendingDeployments = [];
    for (let index = 0; index < plan.deployments.length; index += 1) {
        const deployment = plan.deployments[index];
        if (classifications[index] === 'completed') {
            completedDeployments.push(deployment);
        } else {
            pendingDeployments.push(deployment);
        }
    }

    for (const deployment of completedDeployments) {
        try {
            const current = await fetchTargetWorkflow(apiUrl, apiKey, deployment.id, fetchImpl);
            if (
                current.id !== deployment.id ||
                current.name !== deployment.payload.name ||
                current.active !== false ||
                !matchesExpectedDeployableContent(current, deployment.payload)
            ) {
                throw new Error(
                    `Initially completed target "${deployment.payload.name}" diverged before skip ` +
                    'and does not match expected deployable content'
                );
            }
            assertDataTableTargetIds(current.nodes, deployment.payload.nodes);
            completedWorkflowIds.push(deployment.id);
        } catch (error) {
            throw addP4RecoveryMetadata(
                error,
                plan.deployments,
                completedWorkflowIds,
                deployment.payload.name
            );
        }
    }

    for (let index = 0; index < pendingDeployments.length; index += 1) {
        const deployment = pendingDeployments[index];
        try {
            const current = await fetchTargetWorkflow(apiUrl, apiKey, deployment.id, fetchImpl);
            if (
                current.id !== deployment.id ||
                current.name !== deployment.payload.name ||
                current.active !== false ||
                !isInactiveInertSkeleton(current, deployment.payload.name)
            ) {
                throw new Error(
                    `Pending target "${deployment.payload.name}" changed before PUT; ` +
                    'expected an inactive inert skeleton before PUT'
                );
            }

            // The n8n API exposes no conditional ETag/version write here. This GET narrows,
            // but cannot eliminate, the race before PUT and must not be treated as atomic.
            const response = await fetchImpl(`${apiUrl}/api/v1/workflows/${deployment.id}`, {
                method: 'PUT',
                headers: {
                    'X-N8N-API-KEY': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(deployment.payload)
            });
            if (!response.ok) {
                throw new Error(`Failed to deploy ${deployment.payload.name}: ${await responseError(response)}`);
            }

            const updated = await fetchTargetWorkflow(apiUrl, apiKey, deployment.id, fetchImpl);
            if (updated.active !== false) {
                throw new Error(`Workflow "${deployment.payload.name}" became active after PUT`);
            }
            if (
                updated.id !== deployment.id ||
                updated.name !== deployment.payload.name ||
                !matchesExpectedDeployableContent(updated, deployment.payload)
            ) {
                throw new Error(
                    `Workflow "${deployment.payload.name}" does not match expected deployable content after PUT`
                );
            }
            assertDataTableTargetIds(updated.nodes, deployment.payload.nodes);
            completedWorkflowIds.push(deployment.id);
        } catch (error) {
            throw addP4RecoveryMetadata(
                error,
                plan.deployments,
                completedWorkflowIds,
                deployment.payload.name
            );
        }
    }

    try {
        const finalWorkflows = await fetchTargetWorkflows(apiUrl, apiKey, fetchImpl);
        const finalPlan = buildV3DeploymentPlan(
            workflows,
            finalWorkflows,
            targetWorkflowIds,
            targetDataTableIds,
            sourceWorkflowNames,
            requiredCredentialReferences
        );
        if (!isDeepStrictEqual(comparableV3Plan(plan), comparableV3Plan(finalPlan))) {
            throw new Error('Final target Data Table, selector, or credential authority drifted from the planned authority');
        }
        for (const deployment of finalPlan.deployments) {
            const target = finalPlan.targetsByName.get(deployment.payload.name);
            if (!matchesExpectedDeployableContent(target, deployment.payload)) {
                throw new Error(
                    `Final target workflow "${deployment.payload.name}" does not match expected deployable content`
                );
            }
            assertDataTableTargetIds(target.nodes, deployment.payload.nodes);
        }
    } catch (error) {
        throw addP4RecoveryMetadata(error, plan.deployments, completedWorkflowIds);
    }
}

async function createMissingWorkflows(workflows, workflowIds, targetWorkflowNames, apiUrl, apiKey, fetchImpl) {
    for (const workflow of workflows) {
        if (workflowIds.has(workflow.name)) continue;

        console.log(`Creating missing workflow ${workflow.name} on ${apiUrl}...`);
        const response = await fetchImpl(`${apiUrl}/api/v1/workflows`, {
            method: 'POST',
            headers: {
                'X-N8N-API-KEY': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(createWorkflowPayload(workflow))
        });
        if (!response.ok) {
            throw new Error(`Failed to create ${workflow.name}: ${await responseError(response)}`);
        }

        const targetId = parseCreatedWorkflowId(await response.json());
        workflowIds.set(workflow.name, targetId);
        targetWorkflowNames.set(targetId, workflow.name);
    }
}

async function putWorkflows(deployments, apiUrl, apiKey, fetchImpl) {
    const failures = [];

    for (const deployment of deployments) {
        console.log(`Deploying ${deployment.payload.name} (target ID: ${deployment.id}) to ${apiUrl}...`);
        try {
            const response = await fetchImpl(`${apiUrl}/api/v1/workflows/${deployment.id}`, {
                method: 'PUT',
                headers: {
                    'X-N8N-API-KEY': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(deployment.payload)
            });
            if (!response.ok) {
                throw new Error(await responseError(response));
            }
            console.log(`Successfully deployed: ${deployment.payload.name}`);
        } catch (err) {
            failures.push(`${deployment.payload.name}: ${err.message}`);
            console.error(`Failed to deploy ${deployment.payload.name}:`, err);
        }
    }

    if (failures.length > 0) {
        throw new Error(`Failed to deploy ${failures.length} workflow(s): ${failures.join('; ')}`);
    }
}

async function deployWorkflows(files, { apiUrl, apiKey, fetchImpl = globalThis.fetch }) {
    const workflows = buildRequestedWorkflows(files);
    if (workflows.length === 0) return;
    assertUniqueRequestedWorkflowNames(workflows);
    const sourceWorkflowNames = buildRequestedSourceIdNameMap(workflows);
    const requiredNames = collectRequiredWorkflowNames(workflows);

    const targetWorkflows = await fetchTargetWorkflows(apiUrl, apiKey, fetchImpl);
    const workflowIds = buildWorkflowIdMap(targetWorkflows, requiredNames);
    const targetWorkflowNames = buildWorkflowNameByIdMap(targetWorkflows);
    validateExecuteWorkflowSelectors(workflows, workflowIds, sourceWorkflowNames, targetWorkflowNames);
    await createMissingWorkflows(
        workflows,
        workflowIds,
        targetWorkflowNames,
        apiUrl,
        apiKey,
        fetchImpl
    );

    // Resolve every selector before the first final PUT so callers cannot be partially updated.
    const deployments = workflows.map(workflow => ({
        id: workflowIds.get(workflow.name),
        payload: createWorkflowPayload(
            workflow,
            remapExecuteWorkflowNodes(
                workflow.nodes,
                workflowIds,
                sourceWorkflowNames,
                targetWorkflowNames
            )
        )
    }));

    await putWorkflows(deployments, apiUrl, apiKey, fetchImpl);
}

function runCli() {
    const files = process.argv.slice(2);
    if (files.length === 0) {
        console.error("Usage: node --env-file=.env scripts/deploy.js <path-to-workflow.json | directory> [more files...]");
        process.exitCode = 1;
        return;
    }

    const apiUrl = process.env.REMOTE_N8N_API_URL;
    const apiKey = process.env.REMOTE_N8N_API_KEY;
    if (!apiUrl || !apiKey) {
        console.error("Missing REMOTE_N8N_API_URL or REMOTE_N8N_API_KEY in .env");
        process.exitCode = 1;
        return;
    }

    deployWorkflows(files, { apiUrl, apiKey }).catch(err => {
        console.error('Deployment failed:', err);
        process.exitCode = 1;
    });
}

if (require.main === module) {
    runCli();
}

module.exports = {
    buildRequestedWorkflows,
    deployWorkflows,
    provisionV3WorkflowInventory,
    inspectV3DataTableInventory,
    deployV3WorkflowInventory
};
