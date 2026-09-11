const { isDeepStrictEqual } = require('node:util');
const { createApi } = require('./n8n-api');
const { uniqueIndex, sanitizeWorkflow, comparableNode, diffPaths } = require('./sync-utils');
const {
    buildWorkflowIdMap, buildWorkflowNameByIdMap, remapExecuteWorkflowNodes,
    validateExecuteWorkflowSelectors, collectCredentialReferences, buildCredentialReferenceMap,
    remapCredentialReferences, injectDeploymentValues, createWorkflowPayload
} = require('./deploy-utils');

function validateDefinition(workflow) {
    const allowed = new Set(['id', 'name', 'description', 'active', 'isArchived', 'nodes', 'connections', 'settings', 'tags', 'nodeGroups']);
    for (const key of Object.keys(sanitizeWorkflow(workflow))) {
        if (!allowed.has(key)) throw new Error(`Unsupported shared workflow field: ${workflow.name}.${key}`);
    }
    if (typeof workflow.active !== 'boolean') throw new Error(`Explicit active state required: ${workflow.name}`);
    if (workflow.isArchived) throw new Error(`Archived workflow requires an explicit archive lifecycle operation: ${workflow.name}`);
    uniqueIndex(workflow.nodes, n => n.id, 'node ID');
    const names = uniqueIndex(workflow.nodes, n => n.name, 'node name');
    for (const [from, outputs] of Object.entries(workflow.connections || {})) {
        if (!names.has(from)) throw new Error(`Missing connection source: ${from}`);
        for (const branches of Object.values(outputs)) {
            for (const branch of branches) for (const edge of branch) {
                if (!names.has(edge.node)) throw new Error(`Missing connection target: ${edge.node}`);
            }
        }
    }
}

function comparableSettings(settings = {}) {
    return { callerPolicy: 'workflowsFromSameOwner', availableInMCP: false, executionOrder: 'v1', ...settings };
}

function contentDifferences(actual, expected) {
    const fields = ['name', 'nodes', 'connections', 'description', 'nodeGroups', 'settings'];
    return fields.flatMap(field => {
        if (field === 'nodes') return diffPaths(actual.nodes?.map(comparableNode), expected.nodes?.map(comparableNode), field);
        const left = field === 'settings' ? comparableSettings(actual[field]) : field === 'description' ? actual[field] ?? '' : field === 'nodeGroups' ? actual[field] ?? [] : actual[field];
        const right = field === 'settings' ? comparableSettings(expected[field]) : field === 'description' ? expected[field] ?? '' : field === 'nodeGroups' ? expected[field] ?? [] : expected[field];
        return diffPaths(left, right, field);
    });
}

function tagNames(tags = []) { return tags.map(tag => tag.name).sort(); }

function buildConsistencyPlan(workflows, localInventory, targets, tables, tags) {
    const targetByName = uniqueIndex(targets, w => w.name, 'target workflow name');
    const workflowIds = buildWorkflowIdMap(targets, new Set(targets.map(w => w.name)));
    for (const workflow of workflows) if (!workflowIds.has(workflow.name)) workflowIds.set(workflow.name, `__CREATE__:${workflow.name}`);
    const sourceNames = buildWorkflowNameByIdMap(localInventory);
    const targetNames = buildWorkflowNameByIdMap(targets);
    validateExecuteWorkflowSelectors(workflows, workflowIds, sourceNames, targetNames);
    const tableByName = uniqueIndex(tables, t => t.name, 'target table name');
    const tagByName = uniqueIndex(tags, t => t.name, 'target tag name');
    const credentialIds = buildCredentialReferenceMap(targets, collectCredentialReferences(workflows));
    return workflows.map(workflow => {
        validateDefinition(workflow);
        const target = targetByName.get(workflow.name);
        if (target?.isArchived) throw new Error(`Target is archived: ${workflow.name}`);
        let nodes = remapExecuteWorkflowNodes(workflow.nodes, workflowIds, sourceNames, targetNames);
        nodes = remapCredentialReferences(nodes, credentialIds);
        for (const node of nodes) {
            if (node.type !== 'n8n-nodes-base.dataTable') continue;
            const locator = node.parameters?.dataTableId;
            if (!locator || locator.mode !== 'name') throw new Error(`Canonical Data Table name required: ${node.name}`);
            const table = tableByName.get(locator.value);
            if (!table) throw new Error(`Target Data Table not found: ${locator.value}`);
            node.parameters.dataTableId = { __rl: true, mode: 'id', value: table.id };
        }
        const payload = createWorkflowPayload(workflow, nodes);
        payload.description = workflow.description ?? '';
        payload.nodeGroups = workflow.nodeGroups || [];
        payload.settings = structuredClone(workflow.settings || {});
        if (payload.settings.errorWorkflow) {
            const name = sourceNames.get(payload.settings.errorWorkflow);
            if (!name || !workflowIds.has(name)) throw new Error(`Unknown error workflow: ${workflow.name}`);
            payload.settings.errorWorkflow = workflowIds.get(name);
        }
        const tagIds = (workflow.tags || []).map(tag => {
            const targetTag = tagByName.get(tag.name);
            if (!targetTag) throw new Error(`Target tag must be provisioned before deployment: ${tag.name}`);
            return { id: targetTag.id };
        });
        return {
            id: workflowIds.get(workflow.name), target, payload, tagIds,
            tags: workflow.tags || [], active: workflow.active,
            contentChanges: target ? contentDifferences(target, payload) : ['create'],
            tagsChanged: !isDeepStrictEqual(tagNames(target?.tags), tagNames(workflow.tags)),
            stateChanged: target?.active !== workflow.active
        };
    });
}

async function deployConsistentWorkflows(workflows, {
    apiUrl, apiKey, sttCallbackUrl, localInventory = workflows, dryRun = false, fetchImpl = globalThis.fetch
}) {
    workflows = workflows.map(workflow => injectDeploymentValues(workflow, { sttCallbackUrl }));
    uniqueIndex(workflows, w => w.name, 'requested workflow name');
    workflows.forEach(validateDefinition);
    const api = createApi({ apiUrl, apiKey, fetchImpl });
    const targets = await api.list('workflows');
    // Read the exact definitions, not an assumed list projection, before planning writes.
    for (let i = 0; i < targets.length; i++) {
        const item = targets[i];
        const detail = await api.request(`workflows/${encodeURIComponent(item.id)}`);
        if (detail.id !== item.id || detail.name !== item.name) throw new Error('Target identity drifted during preflight');
        targets[i] = detail;
    }
    const tables = workflows.some(w => w.nodes.some(n => n.type === 'n8n-nodes-base.dataTable')) ? await api.list('data-tables') : [];
    const tags = workflows.some(w => w.tags?.length) ? await api.list('tags') : [];
    let plans = buildConsistencyPlan(workflows, localInventory, targets, tables, tags);
    const summary = plans.map(plan => ({
        name: plan.payload.name, contentChanges: plan.contentChanges,
        tagsChanged: plan.tagsChanged, activeBefore: plan.target?.active ?? null, activeAfter: plan.active,
        publish: plan.active && (plan.stateChanged || plan.contentChanges.length > 0 || plan.target?.activeVersionId !== plan.target?.versionId)
    }));
    if (dryRun) return { dryRun: true, workflows: summary };
    const completed = [];
    const created = [];
    try {
        for (const plan of plans.filter(p => !p.target)) {
            const skeleton = await api.request('workflows', { method: 'POST', body: { name: plan.payload.name, nodes: [], connections: {}, settings: {} } });
            if (!skeleton.id) throw new Error('Create returned no workflow ID');
            created.push(skeleton.id);
            if (skeleton.active !== false || skeleton.name !== plan.payload.name) throw new Error('Create did not return an inactive matching skeleton');
            targets.push(skeleton);
        }
        plans = buildConsistencyPlan(workflows, localInventory, targets, tables, tags);
        for (const plan of plans) {
            const endpoint = `workflows/${encodeURIComponent(plan.id)}`;
            let current = await api.request(endpoint);
            if (current.id !== plan.id || current.name !== plan.payload.name ||
                contentDifferences(current, plan.target).length || current.active !== plan.target.active ||
                (current.isArchived ?? false) !== (plan.target.isArchived ?? false) ||
                current.versionId !== plan.target.versionId || !isDeepStrictEqual(tagNames(current.tags), tagNames(plan.target.tags))) {
                throw new Error(`Target changed after preflight: ${plan.payload.name}`);
            }
            if (!plan.active && current.active) {
                await api.request(`${endpoint}/deactivate`, { method: 'POST' });
                current = await api.request(endpoint);
                if (current.active !== false) throw new Error(`Deactivation was not persisted: ${plan.payload.name}`);
            }
            if (plan.contentChanges.length) {
                await api.request(endpoint, { method: 'PUT', body: plan.payload });
                current = await api.request(endpoint);
                if (current.id !== plan.id || contentDifferences(current, plan.payload).length) {
                    throw new Error(`Content read-back mismatch: ${plan.payload.name}`);
                }
            }
            if (plan.tagsChanged) {
                await api.request(`${endpoint}/tags`, { method: 'PUT', body: plan.tagIds });
            }
            plan.savedVersionId = current.versionId;
            completed.push({ name: plan.payload.name, phase: 'content' });
        }
        // Publish only after every requested definition and dependency has been saved.
        for (const plan of plans) {
            const endpoint = `workflows/${encodeURIComponent(plan.id)}`;
            let current = await api.request(endpoint);
            if (contentDifferences(current, plan.payload).length || current.versionId !== plan.savedVersionId) {
                throw new Error(`Content drifted before publication: ${plan.payload.name}`);
            }
            if (plan.active && (!current.active || current.activeVersionId !== current.versionId)) {
                if (!current.versionId) throw new Error(`Cannot verify publish version: ${plan.payload.name}`);
                await api.request(`${endpoint}/activate`, { method: 'POST', body: { versionId: current.versionId } });
                current = await api.request(endpoint);
            }
            if (current.id !== plan.id || contentDifferences(current, plan.payload).length || current.active !== plan.active ||
                current.isArchived === true ||
                (plan.active && (!current.activeVersionId || current.activeVersionId !== plan.savedVersionId)) ||
                !isDeepStrictEqual(tagNames(current.tags), tagNames(plan.tags))) {
                throw new Error(`Final state read-back mismatch: ${plan.payload.name}`);
            }
            completed.push({ name: plan.payload.name, phase: 'verified' });
        }
        return { dryRun: false, workflows: summary, completed };
    } catch (error) {
        error.completed = completed;
        error.createdWorkflowIds = created;
        // Do not replay or roll back remote side effects automatically.
        throw error;
    }
}

module.exports = { deployConsistentWorkflows, buildConsistencyPlan, contentDifferences };
