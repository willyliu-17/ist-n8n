const TARGET_SCHEDULED_WORKFLOWS = Object.freeze([
    {
        id: 'VeP0aXhGJLwaNyKD',
        name: 'Automation: retry and repair v3',
        reason: 'Every-minute schedule trigger'
    },
    {
        id: 'AlhjHpCxEDE0OAj3',
        name: 'History: ingest v1',
        reason: 'Every-5-minutes schedule trigger'
    },
    {
        id: 'ZLUbVUTBSSNrX3gb',
        name: 'Collect suspect streamID v3',
        reason: 'Daily 10:00 schedule trigger'
    }
]);

async function deactivateSchedules() {
    const oldUrl = process.env.SOURCE_N8N_API_URL || process.env.REMOTE_N8N_API_URL || 'https://34.144.237.1';
    const oldKey = process.env.SOURCE_N8N_API_KEY || process.env.REMOTE_N8N_API_KEY;

    if (!oldKey) {
        throw new Error('Old Prod API key is missing');
    }

    console.log(`=== Deactivating Scheduled Workflows on Old Prod: ${oldUrl} ===\n`);

    for (const target of TARGET_SCHEDULED_WORKFLOWS) {
        console.log(`Checking "${target.name}" (ID: ${target.id})...`);
        const statusRes = await fetch(`${oldUrl}/api/v1/workflows/${target.id}`, {
            headers: { 'X-N8N-API-KEY': oldKey }
        });

        if (!statusRes.ok) {
            console.error(`  Failed to query status: HTTP ${statusRes.status}`);
            continue;
        }

        const data = await statusRes.json();
        console.log(`  Current active status: ${data.active}`);

        if (!data.active) {
            console.log(`  Already inactive. Skipping.\n`);
            continue;
        }

        console.log(`  Sending POST /api/v1/workflows/${target.id}/deactivate...`);
        const deactRes = await fetch(`${oldUrl}/api/v1/workflows/${target.id}/deactivate`, {
            method: 'POST',
            headers: { 'X-N8N-API-KEY': oldKey }
        });

        if (!deactRes.ok) {
            console.error(`  Failed to deactivate: HTTP ${deactRes.status} ${await deactRes.text()}`);
        } else {
            const deactData = await deactRes.json();
            console.log(`  Successfully deactivated! Verified active status: ${deactData.active}\n`);
        }
    }

    console.log('=== Deactivation Completed ===');
}

if (require.main === module) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    deactivateSchedules().catch(err => {
        console.error('Execution error:', err.message);
        process.exitCode = 1;
    });
}

module.exports = { deactivateSchedules, TARGET_SCHEDULED_WORKFLOWS };
