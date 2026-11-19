const fs = require('node:fs');
const path = require('node:path');

const TAG_NAMES = [
    'stt',
    'ist-bot',
    'aliveCheck',
    'experiment',
    'willy',
    'v2',
    'ist-bot-v3'
];

async function syncTags() {
    const targetUrl = process.env.TARGET_N8N_API_URL || process.env.REMOTE_N8N_API_URL;
    const targetKey = process.env.TARGET_N8N_API_KEY || process.env.REMOTE_N8N_API_KEY;

    if (!targetUrl || !targetKey) throw new Error('TARGET_N8N_API_URL and TARGET_N8N_API_KEY are required');

    console.log(`=== Syncing Tags to Target: ${targetUrl} ===\n`);

    // 1. Get existing tags on target
    const res = await fetch(`${targetUrl}/api/v1/tags`, { headers: { 'X-N8N-API-KEY': targetKey } });
    const existingTags = (await res.json()).data || [];
    const tagMap = new Map();

    for (const t of existingTags) {
        if (t.name === 'temp_test_tag') {
            console.log(`Deleting temporary test tag: "${t.name}" (${t.id})...`);
            await fetch(`${targetUrl}/api/v1/tags/${t.id}`, { method: 'DELETE', headers: { 'X-N8N-API-KEY': targetKey } });
        } else {
            tagMap.set(t.name, t.id);
        }
    }

    // 2. Create missing tags
    for (const tagName of TAG_NAMES) {
        if (!tagMap.has(tagName)) {
            console.log(`Creating tag: "${tagName}"...`);
            const createRes = await fetch(`${targetUrl}/api/v1/tags`, {
                method: 'POST',
                headers: { 'X-N8N-API-KEY': targetKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: tagName })
            });
            const created = await createRes.json();
            tagMap.set(tagName, created.id);
            console.log(`  Created with ID: ${created.id}`);
        } else {
            console.log(`Tag already exists: "${tagName}" (ID: ${tagMap.get(tagName)})`);
        }
    }

    // 3. Update workflows with their respective tags
    console.log('\n--- Assigning Tags to Workflows ---');
    const wfRes = await fetch(`${targetUrl}/api/v1/workflows`, { headers: { 'X-N8N-API-KEY': targetKey } });
    const targetWorkflows = (await wfRes.json()).data || [];
    const targetWfByName = new Map(targetWorkflows.map(w => [w.name, w]));

    const workflowsDir = path.resolve(__dirname, '../workflows');
    const dirs = fs.readdirSync(workflowsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);

    for (const d of dirs) {
        const jsonPath = path.join(workflowsDir, d, 'workflow.json');
        if (!fs.existsSync(jsonPath)) continue;
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (raw.isArchived || !raw.tags || raw.tags.length === 0) continue;

        const targetWf = targetWfByName.get(raw.name);
        if (!targetWf) continue;

        const newTags = raw.tags.map(t => {
            const name = t.name || t;
            const id = tagMap.get(name);
            return id ? { id } : null;
        }).filter(Boolean);

        console.log(`Assigning ${newTags.length} tag(s) to "${raw.name}" (ID: ${targetWf.id})...`);
        const putRes = await fetch(`${targetUrl}/api/v1/workflows/${targetWf.id}/tags`, {
            method: 'PUT',
            headers: { 'X-N8N-API-KEY': targetKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(newTags)
        });

        if (!putRes.ok) {
            console.error(`  Failed to update tags for "${raw.name}": HTTP ${putRes.status} ${await putRes.text()}`);
        } else {
            console.log(`  Successfully tagged "${raw.name}"`);
        }
    }

    console.log('\nTag synchronization completed!');
}

if (require.main === module) {
    syncTags().catch(err => {
        console.error('Tag sync failed:', err.message);
        process.exitCode = 1;
    });
}

module.exports = { syncTags };
