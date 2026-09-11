const { V3_DATA_TABLE_NAMES } = require('./stt-summary-v3-inventory');

function buildWorkflowIdMap(workflows, requiredNames) {
    const workflowIds = new Map();

    for (const workflow of workflows) {
        if (requiredNames && !requiredNames.has(workflow.name)) continue;
        if (workflowIds.has(workflow.name)) {
            throw new Error(`Found duplicate workflows exactly named "${workflow.name}" on the target server`);
        }
        workflowIds.set(workflow.name, workflow.id);
    }

    return workflowIds;
}

function assertUniqueRequestedWorkflowNames(workflows) {
    const names = new Set();

    for (const workflow of workflows) {
        if (names.has(workflow.name)) {
            throw new Error(`Found duplicate requested workflows exactly named "${workflow.name}"`);
        }
        names.add(workflow.name);
    }
}

function buildRequestedSourceIdNameMap(workflows) {
    const workflowNames = new Map();

    for (const workflow of workflows) {
        if (!workflow.id) continue;
        if (workflowNames.has(workflow.id)) {
            throw new Error(`Found duplicate requested workflow source ID "${workflow.id}"`);
        }
        workflowNames.set(workflow.id, workflow.name);
    }

    return workflowNames;
}

function buildWorkflowNameByIdMap(workflows) {
    const workflowNames = new Map();

    for (const workflow of workflows) {
        if (workflowNames.has(workflow.id)) {
            throw new Error(`Found duplicate target workflow ID "${workflow.id}"`);
        }
        workflowNames.set(workflow.id, workflow.name);
    }

    return workflowNames;
}

function credentialKey(type, name) {
    return `${type}\u0000${name}`;
}

function isValidCredentialMetadataPart(value) {
    return (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        !/\p{Cc}/u.test(value)
    );
}

function assertCredentialReferenceMetadata(reference) {
    if (
        !reference || typeof reference !== 'object' || Array.isArray(reference) ||
        !isValidCredentialMetadataPart(reference.type) ||
        !isValidCredentialMetadataPart(reference.name) ||
        !isValidCredentialMetadataPart(reference.id)
    ) {
        throw new Error('Invalid credential reference metadata');
    }
}

function collectCredentialReferences(workflows) {
    const references = new Map();

    for (const workflow of workflows) {
        for (const node of workflow.nodes || []) {
            for (const [type, reference] of Object.entries(node.credentials || {})) {
                try {
                    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
                        throw new Error('Invalid credential reference metadata');
                    }
                    assertCredentialReferenceMetadata({
                        type,
                        name: reference?.name,
                        id: reference?.id
                    });
                } catch {
                    throw new Error(
                        `Invalid credential reference metadata in workflow "${workflow.name || '<unknown>'}" ` +
                        `node "${node.name || '<unknown>'}"`
                    );
                }

                const metadata = { type, name: reference.name, id: reference.id };
                references.set(`${credentialKey(type, reference.name)}\u0000${reference.id}`, metadata);
            }
        }
    }

    return [...references.values()];
}

function buildCredentialReferenceMap(targetWorkflows, requiredReferences) {
    const targetIdsByKey = new Map();

    for (const reference of collectCredentialReferences(targetWorkflows)) {
        const key = credentialKey(reference.type, reference.name);
        if (!targetIdsByKey.has(key)) targetIdsByKey.set(key, new Set());
        targetIdsByKey.get(key).add(reference.id);
    }

    const credentialIds = new Map();
    for (const reference of requiredReferences) {
        assertCredentialReferenceMetadata(reference);
        const key = credentialKey(reference.type, reference.name);
        const targetIds = targetIdsByKey.get(key);
        if (!targetIds || targetIds.size === 0) {
            throw new Error(
                `Missing target credential reference for type "${reference.type}" and name "${reference.name}"`
            );
        }
        if (targetIds.size > 1) {
            throw new Error(
                `Ambiguous credential reference for type "${reference.type}" and name "${reference.name}"`
            );
        }
        credentialIds.set(key, targetIds.values().next().value);
    }

    return credentialIds;
}

function remapCredentialReferences(nodes, credentialIds) {
    const remappedNodes = structuredClone(nodes);

    for (const node of remappedNodes) {
        for (const [type, reference] of Object.entries(node.credentials || {})) {
            const key = credentialKey(type, reference.name);
            if (!credentialIds.has(key)) {
                throw new Error(
                    `Missing target credential reference for type "${type}" and name "${reference.name}"`
                );
            }
            reference.id = credentialIds.get(key);
        }
    }

    return remappedNodes;
}

function dataTablePlaceholder(node) {
    const locator = node.parameters?.dataTableId;
    if (
        !locator || typeof locator !== 'object' || Array.isArray(locator) ||
        locator.__rl !== true || locator.mode !== 'name' ||
        Object.keys(locator).length !== 3 ||
        typeof locator.value !== 'string' || !V3_DATA_TABLE_NAMES.includes(locator.value)
    ) {
        throw new Error(
            `Data Table node "${node.name || '<unknown>'}" has an invalid authoritative Data Table placeholder`
        );
    }
    return locator.value;
}

function collectDataTableReferences(workflows) {
    const references = [];

    for (const workflow of workflows) {
        for (const node of workflow.nodes || []) {
            if (node.type !== 'n8n-nodes-base.dataTable') continue;
            references.push({
                workflowName: workflow.name || '<unknown>',
                nodeName: node.name || '<unknown>',
                tableName: dataTablePlaceholder(node)
            });
        }
    }

    return references;
}

function assertCompleteDataTableIdMap(tableIds) {
    if (!(tableIds instanceof Map) || tableIds.size !== V3_DATA_TABLE_NAMES.length) {
        throw new Error('Complete P3 Data Table target ID map is required');
    }

    const seenIds = new Set();
    for (const tableName of V3_DATA_TABLE_NAMES) {
        const id = tableIds.get(tableName);
        if (typeof id !== 'string' || !id.trim()) {
            throw new Error(`Complete P3 Data Table target ID map is required; missing "${tableName}"`);
        }
        if (seenIds.has(id)) {
            throw new Error(`P3 Data Table target ID "${id}" maps to multiple authoritative names`);
        }
        seenIds.add(id);
    }
}

function remapDataTableReferences(nodes, tableIds) {
    assertCompleteDataTableIdMap(tableIds);
    const remappedNodes = structuredClone(nodes);

    for (const node of remappedNodes) {
        if (node.type !== 'n8n-nodes-base.dataTable') continue;
        const tableName = dataTablePlaceholder(node);
        node.parameters.dataTableId = {
            __rl: true,
            mode: 'id',
            value: tableIds.get(tableName)
        };
    }

    return remappedNodes;
}

function preserveTargetDataTableIds(nodes, targetNodes) {
    const remappedNodes = structuredClone(nodes);
    const targetIdsByTableName = new Map();

    for (const node of remappedNodes) {
        if (node.type !== 'n8n-nodes-base.dataTable') continue;
        const tableName = dataTablePlaceholder(node);
        const matches = (targetNodes || []).filter(target => (
            target.type === 'n8n-nodes-base.dataTable' && (
                typeof node.id === 'string' && node.id
                    ? target.id === node.id
                    : target.name === node.name
            )
        ));
        if (matches.length === 0) continue;
        const targetLocator = matches[0]?.parameters?.dataTableId;
        if (
            matches.length !== 1 || !targetLocator || targetLocator.__rl !== true ||
            targetLocator.mode !== 'id' || typeof targetLocator.value !== 'string' ||
            !targetLocator.value
        ) {
            throw new Error(
                `Data Table node "${node.name || '<unknown>'}" has no unique target ID locator`
            );
        }
        const existing = targetIdsByTableName.get(tableName);
        if (existing && existing !== targetLocator.value) {
            throw new Error(`Authoritative Data Table "${tableName}" maps to multiple target IDs`);
        }
        targetIdsByTableName.set(tableName, targetLocator.value);
    }

    for (const node of remappedNodes) {
        if (node.type !== 'n8n-nodes-base.dataTable') continue;
        const tableName = dataTablePlaceholder(node);

        const matches = (targetNodes || []).filter(target => (
            target.type === 'n8n-nodes-base.dataTable' && (
                typeof node.id === 'string' && node.id
                    ? target.id === node.id
                    : target.name === node.name
            )
        ));
        const targetLocator = matches[0]?.parameters?.dataTableId;
        if (matches.length > 1 || (matches.length === 1 && (
            !targetLocator || targetLocator.__rl !== true || targetLocator.mode !== 'id' ||
            typeof targetLocator.value !== 'string' || !targetLocator.value
        ))) {
            throw new Error(
                `Data Table node "${node.name || '<unknown>'}" has no unique target ID locator`
            );
        }
        const targetId = matches.length === 1 ? targetLocator.value : targetIdsByTableName.get(tableName);
        if (!targetId) {
            throw new Error(
                `Data Table node "${node.name || '<unknown>'}" has no unique target ID locator`
            );
        }
        node.parameters.dataTableId = {
            __rl: true,
            mode: 'id',
            value: targetId
        };
    }

    return remappedNodes;
}

function assertDataTableTargetIds(nodes, expectedNodes) {
    const actualDataTableNodes = (nodes || []).filter(node => node.type === 'n8n-nodes-base.dataTable');
    const expectedDataTableNodes = (expectedNodes || []).filter(node => node.type === 'n8n-nodes-base.dataTable');
    if (actualDataTableNodes.length !== expectedDataTableNodes.length) {
        throw new Error('Deployed workflow does not contain the exact expected Data Table nodes');
    }

    for (const expected of expectedDataTableNodes) {
        const matches = actualDataTableNodes.filter(actual => (
            typeof expected.id === 'string' && expected.id
                ? actual.id === expected.id
                : actual.name === expected.name
        ));
        if (matches.length !== 1) {
            throw new Error(`Data Table node "${expected.name || '<unknown>'}" identity does not match deployment input`);
        }
        const actual = matches[0];
        const expectedLocator = expected.parameters?.dataTableId;
        const actualLocator = actual.parameters?.dataTableId;
        if (
            actual.name !== expected.name ||
            !actualLocator || typeof actualLocator !== 'object' || Array.isArray(actualLocator) ||
            actualLocator.__rl !== true || actualLocator.mode !== 'id' ||
            Object.keys(actualLocator).length !== 3 ||
            !expectedLocator || actualLocator.value !== expectedLocator.value
        ) {
            throw new Error(
                `Data Table node "${expected.name || '<unknown>'}" does not use its exact expected Data Table target ID "${expectedLocator?.value || '<missing>'}"`
            );
        }
    }
}

function isExpression(value) {
    return typeof value === 'string' && value.startsWith('=');
}

function usesDatabaseSource(node) {
    return node.parameters?.source === undefined || node.parameters.source === 'database';
}

function getSelector(node) {
    const workflowId = node.parameters?.workflowId;
    if (typeof workflowId === 'string' && workflowId.trim()) {
        return { container: node.parameters, key: 'workflowId', value: workflowId };
    }
    if (
        workflowId &&
        typeof workflowId === 'object' &&
        !Array.isArray(workflowId) &&
        typeof workflowId.value === 'string' &&
        workflowId.value.trim()
    ) {
        return {
            container: workflowId,
            key: 'value',
            value: workflowId.value,
            cachedName: workflowId.cachedResultName
        };
    }
    return null;
}

function collectRequiredWorkflowNames(workflows) {
    const requiredNames = new Set(workflows.map(workflow => workflow.name));

    for (const workflow of workflows) {
        for (const node of workflow.nodes) {
            if (node.type !== 'n8n-nodes-base.executeWorkflow' || !usesDatabaseSource(node)) continue;
            const selector = getSelector(node);
            if (selector && !isExpression(selector.value) && selector.cachedName) {
                requiredNames.add(selector.cachedName);
            }
        }
    }

    return requiredNames;
}

function resolveKnownWorkflowName(value, sourceWorkflowNames, targetWorkflowNames, nodeName) {
    const sourceName = sourceWorkflowNames.get(value);
    const targetName = targetWorkflowNames.get(value);
    if (sourceName && targetName && sourceName !== targetName) {
        throw new Error(
            `Execute Workflow node "${nodeName}" selector value "${value}" resolves to both ` +
            `"${sourceName}" and "${targetName}"`
        );
    }
    return sourceName || targetName;
}

function assertCachedNameMatchesValue(selector, nodeName, sourceWorkflowNames, targetWorkflowNames) {
    const resolvedName = resolveKnownWorkflowName(
        selector.value,
        sourceWorkflowNames,
        targetWorkflowNames,
        nodeName
    );
    if (resolvedName && resolvedName !== selector.cachedName) {
        throw new Error(
            `Execute Workflow node "${nodeName}" has cached workflow name "${selector.cachedName}" ` +
            `but selector value resolves to "${resolvedName}"`
        );
    }
}

function resolveStaticWorkflowId(value, workflowIds, sourceWorkflowNames, targetWorkflowNames, nodeName) {
    resolveKnownWorkflowName(value, sourceWorkflowNames, targetWorkflowNames, nodeName);
    if (sourceWorkflowNames.has(value)) {
        const workflowName = sourceWorkflowNames.get(value);
        if (!workflowIds.has(workflowName)) {
            throw new Error(`Execute Workflow node "${nodeName}" cannot resolve requested workflow "${workflowName}"`);
        }
        return workflowIds.get(workflowName);
    }
    if (targetWorkflowNames.has(value)) return value;
    throw new Error(`Execute Workflow node "${nodeName}" references unknown static workflow ID "${value}"`);
}

function validateExecuteWorkflowSelectors(workflows, workflowIds, sourceWorkflowNames, targetWorkflowNames) {
    const requestedNames = new Set(workflows.map(workflow => workflow.name));

    for (const workflow of workflows) {
        for (const node of workflow.nodes) {
            if (node.type !== 'n8n-nodes-base.executeWorkflow' || !usesDatabaseSource(node)) continue;
            const selector = getSelector(node);
            if (!selector) {
                throw new Error(`Execute Workflow node "${node.name}" has an invalid database workflow selector`);
            }
            if (isExpression(selector.value)) continue;

            if (selector.cachedName) {
                assertCachedNameMatchesValue(selector, node.name, sourceWorkflowNames, targetWorkflowNames);
                if (!workflowIds.has(selector.cachedName) && !requestedNames.has(selector.cachedName)) {
                    throw new Error(`Execute Workflow node "${node.name}" references unknown workflow "${selector.cachedName}"`);
                }
                continue;
            }

            if (typeof selector.value === 'string' && selector.value) {
                if (!sourceWorkflowNames.has(selector.value) && !targetWorkflowNames.has(selector.value)) {
                    throw new Error(`Execute Workflow node "${node.name}" references unknown static workflow ID "${selector.value}"`);
                }
            }
        }
    }
}

function remapExecuteWorkflowNodes(nodes, workflowIds, sourceWorkflowNames = new Map(), targetWorkflowNames = new Map()) {
    const remappedNodes = structuredClone(nodes);

    for (const node of remappedNodes) {
        if (node.type !== 'n8n-nodes-base.executeWorkflow' || !usesDatabaseSource(node)) continue;

        const selector = getSelector(node);
        if (!selector) {
            throw new Error(`Execute Workflow node "${node.name}" has an invalid database workflow selector`);
        }
        if (isExpression(selector.value)) continue;

        if (selector.cachedName) {
            assertCachedNameMatchesValue(selector, node.name, sourceWorkflowNames, targetWorkflowNames);
            if (!workflowIds.has(selector.cachedName)) {
                throw new Error(`Execute Workflow node "${node.name}" references unknown workflow "${selector.cachedName}"`);
            }
            const targetId = workflowIds.get(selector.cachedName);
            selector.container.value = targetId;
            selector.container.cachedResultUrl = `/workflow/${targetId}`;
            continue;
        }

        if (typeof selector.value === 'string' && selector.value) {
            const targetId = resolveStaticWorkflowId(
                selector.value,
                workflowIds,
                sourceWorkflowNames,
                targetWorkflowNames,
                node.name
            );
            selector.container[selector.key] = targetId;
            if (selector.key === 'value' && targetId !== selector.value) {
                selector.container.cachedResultUrl = `/workflow/${targetId}`;
            }
        }
    }

    return remappedNodes;
}

function createWorkflowPayload(workflow, nodes = workflow.nodes) {
    return {
        name: workflow.name,
        nodes,
        connections: workflow.connections,
        settings: workflow.settings
    };
}

const STT_CALLBACK_URL_PLACEHOLDER = '__DEPLOY_STT_CALLBACK_URL__';
const STT_CALLBACK_PATH = '/webhook/stt-callback-v3';

function containsDeploymentPlaceholder(value) {
    if (value === STT_CALLBACK_URL_PLACEHOLDER) return true;
    if (Array.isArray(value)) return value.some(containsDeploymentPlaceholder);
    if (!value || typeof value !== 'object') return false;
    return Object.values(value).some(containsDeploymentPlaceholder);
}

function validateSttCallbackUrl(value) {
    if (typeof value !== 'string' || !value || value !== value.trim()) {
        throw new Error('STT_CALLBACK_URL is required for this deployment');
    }

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('STT_CALLBACK_URL must be a valid HTTPS URL');
    }
    if (
        parsed.protocol !== 'https:' || parsed.pathname !== STT_CALLBACK_PATH ||
        parsed.search || parsed.hash || parsed.username || parsed.password
    ) {
        throw new Error(`STT_CALLBACK_URL must use HTTPS and the exact ${STT_CALLBACK_PATH} path`);
    }
    return parsed.toString();
}

function replaceDeploymentPlaceholder(value, sttCallbackUrl) {
    if (value === STT_CALLBACK_URL_PLACEHOLDER) return sttCallbackUrl;
    if (Array.isArray(value)) {
        return value.map(entry => replaceDeploymentPlaceholder(entry, sttCallbackUrl));
    }
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key,
        replaceDeploymentPlaceholder(entry, sttCallbackUrl)
    ]));
}

function injectDeploymentValues(workflow, { sttCallbackUrl } = {}) {
    if (!containsDeploymentPlaceholder(workflow)) return workflow;
    return replaceDeploymentPlaceholder(workflow, validateSttCallbackUrl(sttCallbackUrl));
}

function parseCreatedWorkflowId(workflow) {
    if (!workflow || workflow.id === undefined || workflow.id === null || workflow.id === '') {
        throw new Error('Created workflow response is missing an ID');
    }
    return workflow.id;
}

module.exports = {
    STT_CALLBACK_URL_PLACEHOLDER,
    validateSttCallbackUrl,
    buildWorkflowIdMap,
    assertUniqueRequestedWorkflowNames,
    buildRequestedSourceIdNameMap,
    buildWorkflowNameByIdMap,
    collectCredentialReferences,
    buildCredentialReferenceMap,
    remapCredentialReferences,
    collectDataTableReferences,
    assertCompleteDataTableIdMap,
    remapDataTableReferences,
    preserveTargetDataTableIds,
    assertDataTableTargetIds,
    collectRequiredWorkflowNames,
    validateExecuteWorkflowSelectors,
    remapExecuteWorkflowNodes,
    injectDeploymentValues,
    createWorkflowPayload,
    parseCreatedWorkflowId
};
