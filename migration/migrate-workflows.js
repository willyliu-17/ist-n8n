const fs = require('node:fs');
const path = require('node:path');
const { buildWorkflow } = require('../scripts/utils');
const { injectDeploymentValues, createWorkflowPayload } = require('../scripts/deploy-utils');

function resolveTableName(node) {
    const val = node.parameters?.dataTableId?.value;
    if (val === 'Lx5XX1urLbFzXqpm') return 'AISummaryV2';
    return val;
}

function loadGitWorkflows() {
    const workflowsDir = path.resolve(__dirname, '../workflows');
    const dirs = fs.readdirSync(workflowsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();

    const workflows = [];
    for (const dir of dirs) {
        const jsonPath = path.join(workflowsDir, dir, 'workflow.json');
        if (!fs.existsSync(jsonPath)) continue;
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (raw.isArchived) {
            console.log(`[EXCLUDED ARCHIVED] Skipping ${raw.name} (${dir})`);
            continue;
        }

        const fullWf = buildWorkflow(path.join(workflowsDir, dir));
        workflows.push({
            dir,
            raw,
            workflow: fullWf
        });
    }
    return workflows;
}

async function migrateWorkflows({ targetUrl, targetKey, dryRun = false }) {
    console.log(`=== Starting Workflow Migration to ${targetUrl} (Dry Run: ${dryRun}) ===`);

    const gitEntries = loadGitWorkflows();
    console.log(`Loaded ${gitEntries.length} unarchived workflow(s) from Git.\n`);

    // 1. Fetch target Data Tables
    const dtRes = await fetch(`${targetUrl}/api/v1/data-tables`, {
        headers: { 'X-N8N-API-KEY': targetKey }
    });
    if (!dtRes.ok) throw new Error(`Failed to fetch target data tables: HTTP ${dtRes.status}`);
    const targetTables = (await dtRes.json()).data || [];
    const targetTableMap = new Map(targetTables.map(t => [t.name, t.id]));
    console.log(`Resolved ${targetTableMap.size} Data Table(s) on target instance.`);

    // 2. Fetch target Workflows
    const wfRes = await fetch(`${targetUrl}/api/v1/workflows`, {
        headers: { 'X-N8N-API-KEY': targetKey }
    });
    if (!wfRes.ok) throw new Error(`Failed to fetch target workflows: HTTP ${wfRes.status}`);
    const existingWorkflows = (await wfRes.json()).data || [];
    const targetWorkflowIdByName = new Map(existingWorkflows.map(w => [w.name, w.id]));
    console.log(`Found ${existingWorkflows.length} existing workflow(s) on target instance.\n`);

    const oldIdToName = new Map();
    for (const entry of gitEntries) {
        if (entry.workflow.id) {
            oldIdToName.set(entry.workflow.id, entry.workflow.name);
        }
    }

    // Pass 1: Ensure every workflow has a target ID
    console.log('--- Pass 1: Provisioning Workflow Placeholders ---');
    for (const entry of gitEntries) {
        const wfName = entry.workflow.name;
        if (!targetWorkflowIdByName.has(wfName)) {
            if (dryRun) {
                console.log(`[Dry-Run] Would create placeholder for: "${wfName}"`);
                targetWorkflowIdByName.set(wfName, `dry_run_id_${wfName.replace(/\W+/g, '_')}`);
            } else {
                console.log(`Creating placeholder for: "${wfName}"...`);
                const createRes = await fetch(`${targetUrl}/api/v1/workflows`, {
                    method: 'POST',
                    headers: {
                        'X-N8N-API-KEY': targetKey,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        name: wfName,
                        nodes: [],
                        connections: {},
                        settings: { executionOrder: 'v1' }
                    })
                });
                if (!createRes.ok) {
                    throw new Error(`Failed to create placeholder for "${wfName}": HTTP ${createRes.status} ${await createRes.text()}`);
                }
                const created = await createRes.json();
                targetWorkflowIdByName.set(wfName, created.id);
                console.log(`  Assigned target ID: ${created.id}`);
            }
        } else {
            console.log(`Placeholder already exists for "${wfName}": ID ${targetWorkflowIdByName.get(wfName)}`);
        }
    }

    // Pass 2: Full deployment with remapped Data Table and Sub-workflow IDs
    console.log('\n--- Pass 2: Deploying Workflows with Resolved Linkages ---');
    const sttCallbackUrl = process.env.STT_CALLBACK_URL || 'https://n8n-ist.17app.co/webhook/stt-callback-v3';

    // Prioritize Automation: error handler v3 so other workflows can bind it as their errorWorkflow
    const sortedEntries = [...gitEntries].sort((a, b) => {
        if (a.workflow.name === 'Automation: error handler v3') return -1;
        if (b.workflow.name === 'Automation: error handler v3') return 1;
        return 0;
    });

    let deployedCount = 0;
    for (const entry of sortedEntries) {
        let wf = structuredClone(entry.workflow);
        const targetId = targetWorkflowIdByName.get(wf.name);

        // Remap Data Tables
        for (const node of wf.nodes || []) {
            if (node.type === 'n8n-nodes-base.dataTable') {
                const tableName = resolveTableName(node);
                if (!targetTableMap.has(tableName)) {
                    throw new Error(`Workflow "${wf.name}" references missing table "${tableName}"`);
                }
                node.parameters.dataTableId = {
                    __rl: true,
                    mode: 'id',
                    value: targetTableMap.get(tableName)
                };
            }

            // Remap Execute Workflow nodes
            if (node.type === 'n8n-nodes-base.executeWorkflow') {
                const p = node.parameters?.workflowId;
                const targetSubWfName = p?.cachedResultName ||
                    oldIdToName.get(p?.value) ||
                    (typeof p === 'string' ? oldIdToName.get(p) : null);

                if (!targetSubWfName || !targetWorkflowIdByName.has(targetSubWfName)) {
                    throw new Error(`Workflow "${wf.name}" references unresolved sub-workflow "${targetSubWfName || JSON.stringify(p)}"`);
                }

                const newSubWfId = targetWorkflowIdByName.get(targetSubWfName);
                if (p && typeof p === 'object') {
                    p.value = newSubWfId;
                    p.mode = 'list';
                    p.cachedResultUrl = `/workflow/${newSubWfId}`;
                } else {
                    node.parameters.workflowId = newSubWfId;
                }
            }
        }

        // Inject STT callback url if placeholder exists
        wf = injectDeploymentValues(wf, { sttCallbackUrl });

        // Remap errorWorkflow in settings if present
        if (wf.settings?.errorWorkflow) {
            const errorWfName = 'Automation: error handler v3';
            const targetErrorWfId = targetWorkflowIdByName.get(errorWfName);
            if (!targetErrorWfId) {
                throw new Error(`Target error workflow "${errorWfName}" not found in target IDs`);
            }
            wf.settings.errorWorkflow = targetErrorWfId;
        }

        // Ensure active is false during initial transfer (except error handler which must be active for published version)
        if (wf.name === 'Automation: error handler v3') {
            wf.active = true;
        } else {
            wf.active = false;
        }

        const payload = createWorkflowPayload(wf);

        if (dryRun) {
            console.log(`[Dry-Run] Would update "${wf.name}" (${wf.nodes.length} nodes) -> target ID ${targetId}`);
        } else {
            console.log(`Updating "${wf.name}" (${wf.nodes.length} nodes) -> target ID ${targetId}...`);
            const putRes = await fetch(`${targetUrl}/api/v1/workflows/${targetId}`, {
                method: 'PUT',
                headers: {
                    'X-N8N-API-KEY': targetKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            if (!putRes.ok) {
                throw new Error(`Failed to deploy "${wf.name}": HTTP ${putRes.status} ${await putRes.text()}`);
            }

            // If error handler, ensure it is activated and published
            if (wf.name === 'Automation: error handler v3') {
                await fetch(`${targetUrl}/api/v1/workflows/${targetId}/activate`, {
                    method: 'POST',
                    headers: { 'X-N8N-API-KEY': targetKey }
                });
                console.log(`  Activated and published error handler workflow: ${targetId}`);
            }

            deployedCount++;
        }
    }

    console.log(`\nWorkflow migration completed! Successfully deployed: ${dryRun ? '0 (Dry-Run)' : deployedCount} workflows.`);
}

async function verifyWorkflows({ targetUrl, targetKey }) {
    console.log(`=== Verifying Workflows on Target Instance: ${targetUrl} ===\n`);
    const gitEntries = loadGitWorkflows();
    const dtRes = await fetch(`${targetUrl}/api/v1/data-tables`, { headers: { 'X-N8N-API-KEY': targetKey } });
    const targetTables = (await dtRes.json()).data || [];
    const validTableIds = new Set(targetTables.map(t => t.id));

    const wfRes = await fetch(`${targetUrl}/api/v1/workflows`, { headers: { 'X-N8N-API-KEY': targetKey } });
    const targetWorkflows = (await wfRes.json()).data || [];
    const targetWfMap = new Map(targetWorkflows.map(w => [w.name, w]));
    const validWfIds = new Set(targetWorkflows.map(w => w.id));

    console.log(`Target workflows present: ${targetWorkflows.length} | Git expected: ${gitEntries.length}\n`);

    let allPassed = true;
    for (const entry of gitEntries) {
        const expected = entry.workflow;
        const actual = targetWfMap.get(expected.name);

        if (!actual) {
            console.log(`[MISSING] Workflow "${expected.name}" NOT found on target.`);
            allPassed = false;
            continue;
        }

        // Fetch full detail
        const detailRes = await fetch(`${targetUrl}/api/v1/workflows/${actual.id}`, { headers: { 'X-N8N-API-KEY': targetKey } });
        const detail = await detailRes.json();

        const expNodeCount = (expected.nodes || []).length;
        const actNodeCount = (detail.nodes || []).length;
        const nodeMatch = expNodeCount === actNodeCount;

        // Check linkage integrity
        let linkPassed = true;
        for (const node of detail.nodes || []) {
            if (node.type === 'n8n-nodes-base.dataTable') {
                const tableId = node.parameters?.dataTableId?.value;
                if (!validTableIds.has(tableId)) {
                    console.log(`  [INVALID TABLE ID] In "${expected.name}" node "${node.name}": ${tableId}`);
                    linkPassed = false;
                }
            }
            if (node.type === 'n8n-nodes-base.executeWorkflow') {
                const subId = typeof node.parameters?.workflowId === 'object'
                    ? node.parameters?.workflowId?.value
                    : node.parameters?.workflowId;
                if (!validWfIds.has(subId)) {
                    console.log(`  [INVALID SUB-WORKFLOW ID] In "${expected.name}" node "${node.name}": ${subId}`);
                    linkPassed = false;
                }
            }
        }

        const status = nodeMatch && linkPassed ? 'PASS' : 'FAIL';
        if (status === 'FAIL') allPassed = false;
        console.log(`[${status}] "${expected.name}": Nodes ${actNodeCount}/${expNodeCount} | Active: ${detail.active} | ID: ${actual.id}`);
    }

    console.log(`\nOverall Verification Result: ${allPassed ? 'ALL CHECKS PASSED (100% OK)' : 'SOME CHECKS FAILED'}`);
}

async function main() {
    const args = process.argv.slice(2);
    const hasFlag = flag => args.includes(flag);

    const targetUrl = process.env.TARGET_N8N_API_URL || process.env.REMOTE_N8N_API_URL;
    const targetKey = process.env.TARGET_N8N_API_KEY || process.env.REMOTE_N8N_API_KEY;

    if (!targetUrl || !targetKey) {
        throw new Error('TARGET_N8N_API_URL and TARGET_N8N_API_KEY are required');
    }

    if (hasFlag('--verify')) {
        await verifyWorkflows({ targetUrl, targetKey });
    } else {
        await migrateWorkflows({ targetUrl, targetKey, dryRun: hasFlag('--dry-run') });
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Workflow migration error:', err.message);
        process.exitCode = 1;
    });
}

module.exports = { migrateWorkflows, verifyWorkflows };
