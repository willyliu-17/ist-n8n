const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { isDeepStrictEqual } = require('node:util');
const { createApi } = require('./n8n-api');
const { V3_WORKFLOW_INVENTORY } = require('./stt-summary-v3-inventory');
const {
    sanitizeWorkflow, comparableWorkflow, createSyncContext, normalizeWorkflow,
    resolveReferences, safeExternalPath, unpackWorkflow, diffPaths
} = require('./sync-utils');
const { assertCleanDirectory, renderWorkflow, applyFilePlan } = require('./sync-files');

const safeName = name => name.replace(/[^a-z0-9_]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();

function loadLocalWorkflows(rootDir) {
    const workflowsDir = path.join(rootDir, 'workflows');
    if (!fs.existsSync(workflowsDir)) return [];
    if (fs.lstatSync(workflowsDir).isSymbolicLink()) throw new Error('Workflows root is a symlink');
    return fs.readdirSync(workflowsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
        const directory = path.join(workflowsDir, entry.name);
        const filename = path.join(directory, 'workflow.json');
        if (!fs.existsSync(filename)) return [];
        safeExternalPath(directory, 'workflow.json');
        const text = fs.readFileSync(filename, 'utf8');
        const raw = JSON.parse(text);
        const read = relative => fs.readFileSync(safeExternalPath(directory, relative), 'utf8');
        return [{ directory, text, raw, read, workflow: resolveReferences(raw, read) }];
    });
}

function planSync(source, local, context, { normalize = true } = {}) {
    const workflow = normalize ? normalizeWorkflow(source, local.workflow, context) : sanitizeWorkflow(source);
    // Explicitly retain the chosen local identity even for non-V3 workflows.
    workflow.id = local.raw.id;
    const before = comparableWorkflow(local.workflow);
    const after = comparableWorkflow(workflow);
    const differences = diffPaths(before, after);
    if (isDeepStrictEqual(before, after)) return { differences, files: new Map() };
    const unpacked = unpackWorkflow(workflow, local.raw, local.read);
    unpacked.files.set('workflow.json', renderWorkflow(unpacked.workflow, local.text));
    return { differences, files: unpacked.files };
}

async function syncWorkflows({
    rootDir = path.resolve(__dirname, '..'), targets = [], apiUrl, apiKey, callbackUrl,
    includeArchived = false, dryRun = false, noUnpack = false, conflict = '', choose, fetchImpl = globalThis.fetch
}) {
    const api = createApi({ apiUrl, apiKey, fetchImpl });
    const inventory = new Map(V3_WORKFLOW_INVENTORY);
    const locals = loadLocalWorkflows(rootDir);
    const sourceList = await api.list('workflows');
    const eligible = sourceList.filter(workflow => includeArchived || !workflow.isArchived);
    let selected = eligible;
    if (targets.length) {
        selected = [];
        for (const target of targets) {
            const localPath = path.resolve(rootDir, target);
            const match = locals.find(local => local.directory === localPath || path.join(local.directory, 'workflow.json') === localPath);
            const name = match?.raw.name || target;
            const candidates = eligible.filter(workflow => workflow.name === name);
            if (!candidates.length) throw new Error(`Workflow not found: ${name}`);
            if (candidates.length > 1) throw new Error(`Ambiguous remote workflow name: ${name}`);
            if (!selected.some(workflow => workflow.id === candidates[0].id)) selected.push(candidates[0]);
        }
    }
    const prepared = [];
    for (const remote of selected) {
        const candidates = locals.filter(local => local.raw.id === remote.id || local.raw.name === remote.name);
        const canonicalDir = inventory.get(remote.name);
        let local = canonicalDir ? locals.find(item => item.directory === path.resolve(rootDir, canonicalDir)) : undefined;
        if (candidates.length > 1) throw new Error(`Ambiguous local workflow: ${remote.name}`);
        local ??= candidates[0];
        const canonicalId = canonicalDir ? path.basename(canonicalDir).split('_').at(-1) : undefined;
        if (local && canonicalId && local.raw.id !== canonicalId) {
            throw new Error(`Local V3 identity needs reconciliation before sync: ${remote.name}`);
        }
        if (local && local.raw.id !== remote.id && !canonicalDir) {
            const decision = conflict || await choose?.(remote.name) || 'S';
            if (decision === 'S') continue;
            if (decision === 'N') local = undefined;
        }
        if (!local) {
            const directory = canonicalDir ? path.resolve(rootDir, canonicalDir) : path.join(rootDir, 'workflows', `${safeName(remote.name)}_${remote.id}`);
            if (fs.existsSync(directory)) throw new Error(`Unmanaged directory already exists: ${directory}`);
            const identity = { id: canonicalId || remote.id, name: remote.name, nodes: [] };
            local = { directory, text: '', raw: identity, workflow: identity, read: () => { throw new Error('Unexpected new-workflow reference'); } };
        }
        prepared.push({ remote, local });
    }
    const sources = [];
    const selectedIds = new Set(prepared.map(({ remote }) => remote.id));
    // List identities resolve dependencies; only selected definitions need full downloads.
    for (const item of sourceList) {
        if (!selectedIds.has(item.id)) { sources.push(item); continue; }
        const detail = await api.request(`workflows/${encodeURIComponent(item.id)}`);
        if (detail?.id !== item.id || detail.name !== item.name || !Array.isArray(detail.nodes) || !detail.connections) {
            throw new Error('Workflow identity or response shape changed during sync');
        }
        sources.push(detail);
    }
    const needsNormalization = prepared.some(({ remote }) => inventory.has(remote.name));
    const tables = needsNormalization && prepared.some(({ remote }) => sources.find(w => w.id === remote.id).nodes.some(n => n.type === 'n8n-nodes-base.dataTable'))
        ? await api.list('data-tables') : [];
    const contextLocals = [...locals.map(l => l.workflow)];
    for (const { local } of prepared) if (!contextLocals.some(w => w.name === local.workflow.name)) contextLocals.push(local.workflow);
    const context = needsNormalization ? createSyncContext({ localWorkflows: contextLocals, sourceWorkflows: sources, tables, callbackUrl }) : undefined;
    const plans = prepared.map(({ remote, local }) => {
        const source = sources.find(w => w.id === remote.id);
        if (!noUnpack) return { local, ...planSync(source, local, context, { normalize: inventory.has(remote.name) }) };
        const workflow = inventory.has(remote.name) ? normalizeWorkflow(source, local.workflow, context) : sanitizeWorkflow(source);
        workflow.id = local.raw.id;
        const directory = path.dirname(local.directory);
        const relative = path.basename(local.directory) + '.json';
        const filename = safeExternalPath(directory, relative);
        const existing = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
        const differences = existing ? diffPaths(comparableWorkflow(JSON.parse(existing)), comparableWorkflow(workflow)) : ['create'];
        return { local: { ...local, directory }, checkPath: filename, differences, files: differences.length ? new Map([[relative, renderWorkflow(workflow, existing)]]) : new Map() };
    });
    for (const plan of plans) for (const [relative, content] of plan.files) {
        const filename = safeExternalPath(plan.local.directory, relative);
        if (fs.existsSync(filename) && fs.readFileSync(filename, 'utf8') === content) plan.files.delete(relative);
    }
    if (!dryRun) for (const plan of plans) {
        if (plan.files.size) assertCleanDirectory(plan.checkPath || plan.local.directory, rootDir);
    }
    const results = [];
    for (const plan of plans) {
        if (!dryRun && plan.files.size) assertCleanDirectory(plan.checkPath || plan.local.directory, rootDir);
        const result = dryRun ? { changed: plan.files.size } : applyFilePlan(plan.local.directory, plan.files);
        results.push({ name: plan.local.raw.name, differences: plan.differences, ...result });
    }
    return results;
}

async function runCli() {
    const flags = new Set(['--include-archived', '--dry-run', '--no-unpack', '--skip', '--overwrite', '--new']);
    const argv = process.argv.slice(2);
    for (const flag of argv.filter(arg => arg.startsWith('--'))) {
        if (!flags.has(flag)) throw new Error(`Unsupported flag: ${flag}`);
    }
    const decisions = argv.filter(arg => ['--skip', '--overwrite', '--new'].includes(arg));
    if (decisions.length > 1) throw new Error('Choose only one conflict flag');
    let rl;
    try {
        const results = await syncWorkflows({
            targets: argv.filter(arg => !arg.startsWith('--')),
            apiUrl: process.env.REMOTE_N8N_API_URL,
            apiKey: process.env.REMOTE_N8N_API_KEY,
            callbackUrl: process.env.STT_CALLBACK_URL,
            includeArchived: argv.includes('--include-archived'),
            dryRun: argv.includes('--dry-run'),
            noUnpack: argv.includes('--no-unpack'),
            conflict: argv.includes('--skip') ? 'S' : argv.includes('--new') ? 'N' : argv.includes('--overwrite') || process.env.SYNC_OVERWRITE === 'true' ? 'O' : '',
            choose: async name => {
                if (!process.stdin.isTTY) throw new Error(`Explicit conflict choice required: ${name}`);
                rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
                const answer = (await rl.question(`${name}: different local ID. [O] overwrite, [N] new, [S] skip: `)).trim().toUpperCase();
                if (!['O', 'N', 'S'].includes(answer)) throw new Error('Invalid conflict choice');
                return answer;
            }
        });
        for (const result of results) console.log(JSON.stringify(result));
    } finally { rl?.close(); }
}

if (require.main === module) runCli().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { syncWorkflows, planSync, loadLocalWorkflows };
