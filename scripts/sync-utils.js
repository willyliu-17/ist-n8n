const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { STT_CALLBACK_URL_PLACEHOLDER, validateSttCallbackUrl } = require('./deploy-utils');

const EXTERNAL = '__EXTERNAL_FILE__://';
const RUNTIME_FIELDS = [
    'createdAt', 'updatedAt', 'versionId', 'versionCounter', 'activeVersionId',
    'activeVersion', 'pinData', 'staticData', 'shared', 'triggerCount', 'meta', 'sourceWorkflowId'
];

function sanitizeWorkflow(workflow) {
    const result = structuredClone(workflow);
    for (const key of RUNTIME_FIELDS) delete result[key];
    if ('description' in result) result.description ??= '';
    if (result.tags) result.tags = result.tags.map(({ name }) => ({ name })).sort((a, b) => a.name.localeCompare(b.name));
    return result;
}

function comparableWorkflow(workflow) {
    const result = sanitizeWorkflow(workflow);
    result.description ??= '';
    result.nodeGroups ??= [];
    result.tags ??= [];
    result.nodes = result.nodes?.map(comparableNode);
    result.settings = { callerPolicy: 'workflowsFromSameOwner', availableInMCP: false, executionOrder: 'v1', ...result.settings };
    return result;
}

// Only defaults verified for the pinned node versions are comparison-equivalent.
// Unknown parameters and future node versions remain visible differences.
function comparableNode(node) {
    const result = structuredClone(node);
    const p = result.parameters || {};
    const defaults = values => { for (const [key, value] of Object.entries(values)) if (!Object.hasOwn(p, key)) p[key] = value; };
    if (node.type === 'n8n-nodes-base.code' && node.typeVersion === 2) defaults({ mode: 'runOnceForAllItems' });
    if (node.type === 'n8n-nodes-base.executeWorkflow' && node.typeVersion === 1.2) defaults({ mode: 'once' });
    if (node.type === 'n8n-nodes-base.splitInBatches' && node.typeVersion === 3) defaults({ batchSize: 1 });
    if (node.type === 'n8n-nodes-base.limit' && node.typeVersion === 1) defaults({ maxItems: 1 });
    if (node.type === 'n8n-nodes-base.merge' && node.typeVersion === 3.2) {
        defaults({ mode: 'append' });
        if (['append', 'combineBySql'].includes(p.mode)) defaults({ numberInputs: 2 });
    }
    if (node.type === 'n8n-nodes-base.scheduleTrigger' && node.typeVersion === 1.4) {
        for (const interval of p.rule?.interval || []) {
            if ((!interval.field || ['hours', 'days', 'weeks', 'months'].includes(interval.field)) && !Object.hasOwn(interval, 'triggerAtMinute')) interval.triggerAtMinute = 0;
        }
    }
    if (node.type === 'n8n-nodes-base.slack' && node.typeVersion === 2.3) {
        defaults({ resource: 'message' });
        if (p.resource === 'message') {
            defaults({ operation: 'post' });
            if (['post', 'update'].includes(p.operation)) defaults({ messageType: 'text' });
            if (p.operation === 'update' && isDeepStrictEqual(p.updateFields, {})) delete p.updateFields;
        }
    }
    if (node.type === 'n8n-nodes-base.httpRequest' && node.typeVersion === 4.3 && p.sendBody === true) {
        defaults({ contentType: 'json' });
        if (['json', 'form-urlencoded'].includes(p.contentType)) defaults({ specifyBody: 'keypair' });
    }
    if (result.parameters) result.parameters = p;
    return result;
}

function uniqueIndex(items, key, label) {
    const index = new Map();
    for (const item of items) {
        const value = key(item);
        if (typeof value !== 'string' || !value || index.has(value)) {
            throw new Error(`Missing or ambiguous ${label}`);
        }
        index.set(value, item);
    }
    return index;
}

function credentialIndex(workflows) {
    const ids = new Map();
    const names = new Map();
    for (const workflow of workflows) {
        for (const node of workflow.nodes || []) {
            for (const [type, reference] of Object.entries(node.credentials || {})) {
                if (!reference.id || !reference.name) throw new Error('Invalid credential reference');
                const key = JSON.stringify([type, reference.name]);
                const idKey = JSON.stringify([type, reference.id]);
                if ((ids.has(idKey) && ids.get(idKey) !== key) ||
                    (names.has(key) && names.get(key).id !== reference.id)) {
                    throw new Error('Ambiguous credential identity');
                }
                ids.set(idKey, key);
                names.set(key, reference);
            }
        }
    }
    return names;
}

function createSyncContext({ localWorkflows, sourceWorkflows, tables = [], callbackUrl }) {
    return {
        localByName: uniqueIndex(localWorkflows, w => w.name, 'local workflow name'),
        sourceById: uniqueIndex(sourceWorkflows, w => w.id, 'source workflow ID'),
        sourceByName: uniqueIndex(sourceWorkflows, w => w.name, 'source workflow name'),
        tablesById: uniqueIndex(tables, t => t.id, 'Data Table ID'),
        tablesByName: uniqueIndex(tables, t => t.name, 'Data Table name'),
        localCredentials: credentialIndex(localWorkflows),
        sourceCredentials: credentialIndex(sourceWorkflows),
        callbackUrl: callbackUrl ? validateSttCallbackUrl(callbackUrl) : undefined
    };
}

function matchNodes(sourceNodes, localNodes) {
    const localById = uniqueIndex(localNodes, n => n.id, 'local node ID');
    const localByName = uniqueIndex(localNodes, n => n.name, 'local node name');
    uniqueIndex(sourceNodes, n => n.id, 'source node ID');
    uniqueIndex(sourceNodes, n => n.name, 'source node name');
    const used = new Set();
    const result = new Map();
    for (const node of sourceNodes) {
        const byId = localById.get(node.id);
        const byName = localByName.get(node.name);
        if (byId && byName && byId !== byName) throw new Error(`Ambiguous node identity: ${node.name}`);
        const match = byId || byName;
        if (match) {
            if (used.has(match.id)) throw new Error(`Repeated node match: ${node.name}`);
            used.add(match.id);
            result.set(node.id, match);
        }
    }
    return result;
}

function remapWorkflowId(value, cachedName, context) {
    if (typeof value !== 'string' || !value) throw new Error('Invalid workflow reference');
    if (value.startsWith('=')) return value;
    const source = context.sourceById.get(value);
    if (!source || (cachedName && source.name !== cachedName)) throw new Error('Unknown or contradictory workflow reference');
    const local = context.localByName.get(source.name);
    if (!local) throw new Error(`Workflow reference has no local definition: ${source.name}`);
    return local.id;
}

function mapPlaceholder(source, baseline, context) {
    if (baseline === STT_CALLBACK_URL_PLACEHOLDER) {
        if (source === STT_CALLBACK_URL_PLACEHOLDER) return source;
        if (!context.callbackUrl || source !== context.callbackUrl) {
            throw new Error('Callback deployment value is missing or changed; review it before normalization');
        }
        return STT_CALLBACK_URL_PLACEHOLDER;
    }
    if (Array.isArray(source)) return source.map((value, i) => mapPlaceholder(value, baseline?.[i], context));
    if (source && typeof source === 'object') {
        return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, mapPlaceholder(value, baseline?.[key], context)]));
    }
    return source;
}

function normalizeWorkflow(source, baseline, context) {
    const local = context.localByName.get(source.name);
    if (!local || local.id !== baseline.id) throw new Error('Workflow does not match its local identity');
    const result = sanitizeWorkflow(source);
    result.id = baseline.id;
    const matches = matchNodes(source.nodes, baseline.nodes);
    const nodeIds = new Map();
    result.nodes = result.nodes.map(node => {
        const old = matches.get(node.id);
        nodeIds.set(node.id, old?.id || node.id);
        node.id = old?.id || node.id;
        node.parameters = mapPlaceholder(node.parameters, old?.parameters, context);
        if (node.type === 'n8n-nodes-base.executeWorkflow' &&
            (node.parameters.source === undefined || node.parameters.source === 'database')) {
            const selector = node.parameters.workflowId;
            if (typeof selector === 'string') {
                node.parameters.workflowId = remapWorkflowId(selector, undefined, context);
            } else if (selector && typeof selector.value === 'string') {
                if (!selector.value.startsWith('=')) {
                    selector.value = remapWorkflowId(selector.value, selector.cachedResultName, context);
                    if ('cachedResultUrl' in selector) selector.cachedResultUrl = `/workflow/${selector.value}`;
                }
            } else throw new Error(`Invalid workflow selector: ${node.name}`);
        }
        if (node.type === 'n8n-nodes-base.dataTable') {
            const locator = node.parameters.dataTableId;
            if (!locator || typeof locator.value !== 'string') throw new Error(`Invalid Data Table locator: ${node.name}`);
            if (!locator.value.startsWith('=')) {
                const table = locator.mode === 'name' ? context.tablesByName.get(locator.value) : context.tablesById.get(locator.value);
                if (!table) throw new Error(`Unresolved Data Table identity: ${node.name}`);
                if (locator.cachedResultName && locator.cachedResultName !== table.name) throw new Error(`Contradictory Data Table name: ${node.name}`);
                node.parameters.dataTableId = { __rl: true, mode: 'name', value: table.name };
            }
        }
        for (const [type, ref] of Object.entries(node.credentials || {})) {
            const key = JSON.stringify([type, ref.name]);
            if (context.sourceCredentials.get(key)?.id !== ref.id) throw new Error('Unverified source credential');
            const target = context.localCredentials.get(key);
            if (!target) throw new Error(`New credential requires a canonical reference: ${type}/${ref.name}`);
            node.credentials[type] = { ...ref, id: target.id };
        }
        return node;
    });
    if (result.settings?.errorWorkflow) {
        result.settings.errorWorkflow = remapWorkflowId(result.settings.errorWorkflow, undefined, context);
    }
    // Node group membership stores IDs; never replace arbitrary strings globally.
    for (const group of result.nodeGroups || []) {
        if (Array.isArray(group.nodeIds)) group.nodeIds = group.nodeIds.map(id => {
            if (!nodeIds.has(id)) throw new Error('Unknown node group member');
            return nodeIds.get(id);
        });
    }
    return result;
}

function safeExternalPath(baseDir, relativePath) {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\')) throw new Error('Invalid external file path');
    const absolute = path.resolve(baseDir, relativePath);
    const root = path.resolve(baseDir);
    if (!absolute.startsWith(root + path.sep)) throw new Error('External file escapes workflow directory');
    let cursor = absolute;
    while (cursor !== root) {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('External file path contains a symlink');
        cursor = path.dirname(cursor);
    }
    if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('Workflow directory is a symlink');
    return absolute;
}

function resolveReferences(value, readFile) {
    if (typeof value === 'string' && value.startsWith(EXTERNAL)) return readFile(value.slice(EXTERNAL.length));
    if (Array.isArray(value)) return value.map(entry => resolveReferences(entry, readFile));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveReferences(entry, readFile)]));
    return value;
}

const EXTRACTIONS = [
    [/^n8n-nodes-base\.code$/, ['jsCode'], 'js', true],
    [/^n8n-nodes-base\.code$/, ['pythonCode'], 'py', true],
    [/^(n8n-nodes-base\.slack|@n8n\/n8n-nodes-langchain\..*)$/, ['text'], 'md'],
    [/^@n8n\/n8n-nodes-langchain\./, ['options', 'systemMessage'], 'md'],
    [/^n8n-nodes-base\.(googleBigQuery|postgres)$/, ['sqlQuery'], 'sql'],
    [/^n8n-nodes-base\.(googleBigQuery|postgres)$/, ['query'], 'sql'],
    [/^@n8n\/n8n-nodes-langchain\.outputParserStructured$/, ['inputSchema'], 'json'],
    [/^n8n-nodes-base\.httpRequest$/, ['jsonBody'], 'jsonc'],
    [/^n8n-nodes-base\.set$/, ['jsonOutput'], 'jsonc']
];

function getAt(value, keys) { return keys.reduce((v, k) => v?.[k], value); }

function unpackWorkflow(workflow, baseline, readBaseline) {
    const result = structuredClone(workflow);
    const matches = matchNodes(result.nodes, baseline.nodes || []);
    const files = new Map();
    const reservations = new Map();
    function reserve(value) {
        if (typeof value === 'string' && value.startsWith(EXTERNAL)) {
            const relative = value.slice(EXTERNAL.length);
            const key = relative.toLowerCase();
            if (reservations.has(key) && reservations.get(key) !== relative) throw new Error('Case-insensitive external path collision');
            reservations.set(key, relative);
        } else if (value && typeof value === 'object') Object.values(value).forEach(reserve);
    }
    reserve(baseline);
    for (const node of result.nodes) {
        const old = matches.get(node.id);
        for (const [type, keys, ext, always] of EXTRACTIONS) {
            if (!type.test(node.type)) continue;
            const value = getAt(node.parameters, keys);
            if (typeof value !== 'string') continue;
            const prior = getAt(old?.parameters, keys);
            if (prior === value && !value.startsWith(EXTERNAL)) continue;
            let relative;
            if (typeof prior === 'string' && prior.startsWith(EXTERNAL) && readBaseline(prior.slice(EXTERNAL.length)) === value) {
                relative = prior.slice(EXTERNAL.length);
            } else {
                if (!always && value.length <= 200 && value.split('\n').length <= 10 && !prior?.startsWith(EXTERNAL)) continue;
                const safeName = node.name.replace(/[^a-z0-9_]/gi, '_') || 'Node';
                relative = `nodes/${safeName}/${keys.join('_')}.${ext}`;
                if (reservations.has(relative.toLowerCase())) {
                    // A shared or stale path must not be overwritten with divergent content.
                    if (readBaseline(reservations.get(relative.toLowerCase())) === value) {
                        relative = reservations.get(relative.toLowerCase());
                    } else {
                        const suffix = require('node:crypto').createHash('sha256').update(node.id + keys.join('.')).digest('hex').slice(0, 12);
                        relative = `nodes/${safeName}_${suffix}/${keys.join('_')}.${ext}`;
                    }
                }
            }
            const collision = reservations.get(relative.toLowerCase());
            if (collision && collision !== relative) throw new Error('Case-insensitive extraction collision');
            if (files.has(relative) && files.get(relative) !== value) throw new Error('Divergent extraction collision');
            reservations.set(relative.toLowerCase(), relative);
            files.set(relative, value);
            getAt(node.parameters, keys.slice(0, -1))[keys.at(-1)] = EXTERNAL + relative;
        }
    }
    return { workflow: result, files };
}

function diffPaths(before, after, prefix = '') {
    if (isDeepStrictEqual(before, after)) return [];
    if (prefix === 'nodes' && Array.isArray(before) && Array.isArray(after)) {
        const old = new Map(before.map(node => [node.id, node]));
        const current = new Map(after.map(node => [node.id, node]));
        return [
            ...(isDeepStrictEqual([...old.keys()], [...current.keys()]) ? [] : ['nodes.order']),
            ...[...new Set([...old.keys(), ...current.keys()])].flatMap(id =>
                diffPaths(old.get(id), current.get(id), `nodes[${current.get(id)?.name || old.get(id).name}]`))
        ];
    }
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
        return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => diffPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
    }
    return [prefix];
}

module.exports = {
    EXTERNAL, RUNTIME_FIELDS, sanitizeWorkflow, comparableWorkflow, comparableNode, createSyncContext,
    normalizeWorkflow, matchNodes, safeExternalPath, resolveReferences, unpackWorkflow, diffPaths, uniqueIndex
};
