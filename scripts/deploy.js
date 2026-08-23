const fs = require('fs');
const path = require('path');
const { buildWorkflow, resolveExternalFiles } = require('./utils');
const {
    buildWorkflowIdMap,
    assertUniqueRequestedWorkflowNames,
    buildRequestedSourceIdNameMap,
    buildWorkflowNameByIdMap,
    collectRequiredWorkflowNames,
    validateExecuteWorkflowSelectors,
    remapExecuteWorkflowNodes,
    createWorkflowPayload,
    parseCreatedWorkflowId
} = require('./deploy-utils');

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

module.exports = { buildRequestedWorkflows, deployWorkflows };
