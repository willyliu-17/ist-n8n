const fs = require('fs');
const path = require('path');
const { buildWorkflow, resolveExternalFiles } = require('./utils');

const apiUrl = process.env.REMOTE_N8N_API_URL;
const apiKey = process.env.REMOTE_N8N_API_KEY;

if (!apiUrl || !apiKey) {
    console.error("Missing REMOTE_N8N_API_URL or REMOTE_N8N_API_KEY in .env");
    process.exit(1);
}

const files = process.argv.slice(2);

if (files.length === 0) {
    console.error("Usage: node --env-file=.env scripts/deploy.js <path-to-workflow.json | directory> [more files...]");
    process.exit(1);
}

async function deployWorkflows() {
    for (const file of files) {
        const filePath = path.resolve(file);
        if (!fs.existsSync(filePath)) {
            console.error(`File not found: ${filePath}`);
            continue;
        }

        let wfData;
        if (fs.statSync(filePath).isDirectory()) {
            try {
                wfData = buildWorkflow(filePath);
            } catch (err) {
                console.error(`Error building workflow from directory ${filePath}:`, err);
                continue;
            }
        } else {
            wfData = resolveExternalFiles(JSON.parse(fs.readFileSync(filePath, 'utf8')), path.dirname(filePath));
        }
        const wfId = wfData.id;
        if (!wfId) { console.error('Workflow ID is missing'); continue; }

        console.log(`Deploying ${wfData.name} (ID: ${wfId}) to ${apiUrl}...`);
        
        try {
            // First check if it exists by name to handle cross-environment deployment correctly
            const nameQuery = encodeURIComponent(wfData.name);
            const checkRes = await fetch(`${apiUrl}/api/v1/workflows?name=${nameQuery}`, {
                headers: { 'X-N8N-API-KEY': apiKey }
            });

            if (!checkRes.ok) {
                console.error(`Failed to fetch workflows from server to check for existence`);
                continue;
            }

            const checkData = await checkRes.json();
            const matchingWorkflows = (checkData.data || []).filter(w => w.name === wfData.name);

            if (matchingWorkflows.length > 1) {
                console.error(`Error: Found ${matchingWorkflows.length} workflows exactly named "${wfData.name}" on the target server.`);
                console.error(`Aborting to prevent unintended overwrites. Please manually resolve the duplicates (IDs: ${matchingWorkflows.map(w => w.id).join(', ')}) on the target server.`);
                continue;
            }

            const method = matchingWorkflows.length === 1 ? 'PUT' : 'POST';
            const endpoint = matchingWorkflows.length === 1 ? `${apiUrl}/api/v1/workflows/${matchingWorkflows[0].id}` : `${apiUrl}/api/v1/workflows`;

            const payload = {
                name: wfData.name,
                nodes: wfData.nodes,
                connections: wfData.connections,
                settings: wfData.settings
            };

            const res = await fetch(endpoint, {
                method: method,
                headers: { 
                    'X-N8N-API-KEY': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const err = await res.json();
                console.error(`Failed to deploy ${wfData.name}:`, err);
            } else {
                console.log(`Successfully deployed: ${wfData.name}`);
            }
        } catch (err) {
            console.error(`Error deploying ${wfData.name}:`, err);
        }
    }
}

deployWorkflows();