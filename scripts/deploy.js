const fs = require('fs');
const path = require('path');
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
    collectRequiredWorkflowNames,
    validateExecuteWorkflowSelectors,
    remapExecuteWorkflowNodes,
    createWorkflowPayload,
    parseCreatedWorkflowId
} = require('./deploy-utils');
const { V3_WORKFLOW_INVENTORY } = require('./stt-summary-v3-inventory');

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
        typeof evidence.reference !== 'string' || !evidence.reference.trim()
    ) {
        throw new Error(`Explicit ${label} evidence is required`);
    }
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

function assertP4Inputs(approvalEvidence, p3SchemaEvidence, targetWorkflowIds) {
    assertGateEvidence(approvalEvidence, 'P4', 'P4 approval');
    assertGateEvidence(p3SchemaEvidence, 'P3', 'P3 schema');
    if (!(targetWorkflowIds instanceof Map)) {
        throw new Error('Complete P2 target workflow IDs are required');
    }
    for (const [name] of V3_WORKFLOW_INVENTORY) {
        const id = targetWorkflowIds.get(name);
        if (typeof id !== 'string' || !id) {
            throw new Error(`Complete P2 target workflow IDs are required; missing "${name}"`);
        }
    }
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
    if (failedWorkflowName) error.failedWorkflowName = failedWorkflowName;
    return error;
}

function buildV3DeploymentPlan(
    workflows,
    targetWorkflows,
    targetWorkflowIds,
    sourceWorkflowNames,
    requiredCredentialReferences
) {
    const targetsByName = validateP2TargetIdentity(targetWorkflows, targetWorkflowIds);
    const targetWorkflowNames = buildWorkflowNameByIdMap(targetWorkflows);
    validateExecuteWorkflowSelectors(
        workflows,
        targetWorkflowIds,
        sourceWorkflowNames,
        targetWorkflowNames
    );
    const credentialIds = buildCredentialReferenceMap(targetWorkflows, requiredCredentialReferences);
    const deployments = workflows.map(workflow => {
        const clonedWorkflow = structuredClone(workflow);
        const selectorRemappedNodes = remapExecuteWorkflowNodes(
            clonedWorkflow.nodes,
            targetWorkflowIds,
            sourceWorkflowNames,
            targetWorkflowNames
        );
        const nodes = remapCredentialReferences(selectorRemappedNodes, credentialIds);
        return {
            id: targetWorkflowIds.get(workflow.name),
            payload: createWorkflowPayload(clonedWorkflow, nodes)
        };
    });

    return { targetsByName, credentialIds, deployments };
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
        deployments: plan.deployments,
        ...(classifications ? { classifications } : {})
    };
}

async function deployV3WorkflowInventory({
    apiUrl,
    apiKey,
    approvalEvidence,
    p3SchemaEvidence,
    targetWorkflowIds,
    rootDir = path.resolve(__dirname, '..'),
    fetchImpl = globalThis.fetch
}) {
    assertP4Inputs(approvalEvidence, p3SchemaEvidence, targetWorkflowIds);

    const files = V3_WORKFLOW_INVENTORY.map(([, relativePath]) => path.resolve(rootDir, relativePath));
    const workflows = buildRequestedWorkflows(files);
    assertUniqueRequestedWorkflowNames(workflows);
    for (let index = 0; index < V3_WORKFLOW_INVENTORY.length; index += 1) {
        if (workflows[index].name !== V3_WORKFLOW_INVENTORY[index][0]) {
            throw new Error(`Inventory workflow name mismatch at "${V3_WORKFLOW_INVENTORY[index][1]}"`);
        }
    }

    const requiredCredentialReferences = collectCredentialReferences(workflows);
    const sourceWorkflowNames = buildRequestedSourceIdNameMap(workflows);
    const initialTargetWorkflows = await fetchTargetWorkflows(apiUrl, apiKey, fetchImpl);
    const initialPlan = buildV3DeploymentPlan(
        workflows,
        initialTargetWorkflows,
        targetWorkflowIds,
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
        completedWorkflowIds.push(deployment.id);
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
            sourceWorkflowNames,
            requiredCredentialReferences
        );
        if (!isDeepStrictEqual(comparableV3Plan(plan), comparableV3Plan(finalPlan))) {
            throw new Error('Final target selector or credential authority drifted from the planned authority');
        }
        for (const deployment of finalPlan.deployments) {
            const target = finalPlan.targetsByName.get(deployment.payload.name);
            if (!matchesExpectedDeployableContent(target, deployment.payload)) {
                throw new Error(
                    `Final target workflow "${deployment.payload.name}" does not match expected deployable content`
                );
            }
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
    deployV3WorkflowInventory
};
