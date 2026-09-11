const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createApi } = require('./n8n-api');
const { V3_WORKFLOW_INVENTORY } = require('./stt-summary-v3-inventory');
const { createSyncContext, normalizeWorkflow, resolveReferences, safeExternalPath, EXTERNAL, unpackWorkflow, comparableWorkflow, diffPaths } = require('./sync-utils');
const { applyFilePlan, renderWorkflow } = require('./sync-files');

function externalPaths(value, result = new Set()) {
    if (typeof value === 'string' && value.startsWith(EXTERNAL)) result.add(value.slice(EXTERNAL.length));
    else if (value && typeof value === 'object') Object.values(value).forEach(entry => externalPaths(entry, result));
    return result;
}

async function reconcile({ rootDir, baseline, backupDir, apiUrl, apiKey, callbackUrl, apply = false, fetchImpl = globalThis.fetch }) {
    const git = (...args) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    const commit = git('rev-parse', '--verify', `${baseline}^{commit}`).trim();
    const tracked = new Set(git('ls-tree', '-r', '--name-only', commit, '--', 'workflows').trim().split('\n'));
    const readGit = relative => git('show', `${commit}:${relative}`);
    const localRecords = [...tracked].filter(file => file.endsWith('/workflow.json')).map(file => {
        const relativeDir = path.dirname(file);
        const text = readGit(file);
        const raw = JSON.parse(text);
        const read = relative => {
            safeExternalPath(path.join(rootDir, relativeDir), relative);
            return readGit(path.posix.join(relativeDir, relative));
        };
        return { relativeDir, text, raw, read, workflow: resolveReferences(raw, read) };
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    if (manifest.head !== commit) throw new Error('Backup baseline does not match requested commit');
    const hashes = new Map(manifest.files.map(entry => [entry.path, entry.sha256]));
    function readSnapshot(relative) {
        if (!hashes.has(relative)) {
            const matches = [...hashes.keys()].filter(key => key.toLowerCase() === relative.toLowerCase());
            if (matches.length !== 1) throw new Error(`Missing or ambiguous backup path: ${relative}`);
            relative = matches[0];
        }
        const file = safeExternalPath(backupDir, relative);
        const content = fs.readFileSync(file);
        if (crypto.createHash('sha256').update(content).digest('hex') !== hashes.get(relative)) throw new Error('Backup integrity mismatch');
        if (apply) {
            const current = fs.readFileSync(safeExternalPath(rootDir, relative));
            if (!current.equals(content)) throw new Error(`File changed since backup: ${relative}`);
        }
        return content.toString('utf8');
    }
    const api = createApi({ apiUrl, apiKey, fetchImpl });
    const [sourceWorkflows, tables] = await Promise.all([api.list('workflows'), api.list('data-tables')]);
    for (let i = 0; i < sourceWorkflows.length; i++) {
        if (!Array.isArray(sourceWorkflows[i].nodes)) sourceWorkflows[i] = await api.request(`workflows/${encodeURIComponent(sourceWorkflows[i].id)}`);
    }
    const context = createSyncContext({ localWorkflows: localRecords.map(r => r.workflow), sourceWorkflows, tables, callbackUrl });
    for (const relative of hashes.keys()) readSnapshot(relative);
    const plans = V3_WORKFLOW_INVENTORY.map(([name, relativeDir]) => {
        const local = localRecords.find(record => record.relativeDir === relativeDir);
        if (!local) throw new Error(`Missing baseline: ${name}`);
        const sourceRaw = JSON.parse(readSnapshot(`${relativeDir}/workflow.json`));
        if (context.sourceById.get(sourceRaw.id)?.name !== name) throw new Error(`Snapshot no longer matches source identity: ${name}`);
        const source = resolveReferences(sourceRaw, relative => readSnapshot(`${relativeDir}/${relative}`));
        const normalized = normalizeWorkflow(source, local.workflow, context);
        const unpacked = unpackWorkflow(normalized, local.raw, local.read);
        const files = unpacked.files;
        files.set('workflow.json', renderWorkflow(unpacked.workflow, local.text));
        const references = externalPaths(unpacked.workflow);
        const sourceReferences = externalPaths(sourceRaw);
        const remove = [];
        for (const snapshotPath of hashes.keys()) {
            if (!snapshotPath.startsWith(relativeDir + '/')) continue;
            const relative = snapshotPath.slice(relativeDir.length + 1);
            if (relative === 'workflow.json' || references.has(relative) || files.has(relative)) continue;
            if (!sourceReferences.has(relative)) continue;
            const current = readSnapshot(snapshotPath);
            if (!tracked.has(snapshotPath)) remove.push(relative);
            else {
                const original = readGit(snapshotPath);
                if (current !== original) files.set(relative, original);
            }
        }
        return { name, directory: path.join(rootDir, relativeDir), files, remove, differences: diffPaths(comparableWorkflow(local.workflow), comparableWorkflow(normalized)) };
    });
    // Every workflow is planned and backup-checked before any local write.
    return plans.map(plan => ({
        name: plan.name, differences: plan.differences, removedCopies: plan.remove.length,
        ...(apply ? applyFilePlan(plan.directory, plan.files, { remove: plan.remove }) : { plannedFiles: plan.files.size })
    }));
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const value = flag => args[args.indexOf(flag) + 1];
    if (!args.includes('--baseline') || !args.includes('--backup')) {
        console.error('Usage: reconcile-sync.js --baseline <commit> --backup <verified-backup-dir> [--apply]');
        process.exitCode = 1;
    } else reconcile({
        rootDir: path.resolve(__dirname, '..'), baseline: value('--baseline'), backupDir: path.resolve(value('--backup')),
        apply: args.includes('--apply'), apiUrl: process.env.REMOTE_N8N_API_URL,
        apiKey: process.env.REMOTE_N8N_API_KEY, callbackUrl: process.env.STT_CALLBACK_URL
    }).then(results => console.log(JSON.stringify(results, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { reconcile };
