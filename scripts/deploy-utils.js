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

function parseCreatedWorkflowId(workflow) {
    if (!workflow || workflow.id === undefined || workflow.id === null || workflow.id === '') {
        throw new Error('Created workflow response is missing an ID');
    }
    return workflow.id;
}

module.exports = {
    buildWorkflowIdMap,
    assertUniqueRequestedWorkflowNames,
    buildRequestedSourceIdNameMap,
    buildWorkflowNameByIdMap,
    collectRequiredWorkflowNames,
    validateExecuteWorkflowSelectors,
    remapExecuteWorkflowNodes,
    createWorkflowPayload,
    parseCreatedWorkflowId
};
