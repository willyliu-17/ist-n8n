const fs = require('fs');
const path = require('path');

const apiUrl = process.env.REMOTE_N8N_API_URL;
const apiKey = process.env.REMOTE_N8N_API_KEY;
const includeArchived = process.argv.includes('--include-archived');

if (!apiUrl || !apiKey) {
    console.error("Missing REMOTE_N8N_API_URL or REMOTE_N8N_API_KEY in .env");
    process.exit(1);
}

const workflowsDir = path.join(__dirname, '..', 'workflows');
if (!fs.existsSync(workflowsDir)) {
    fs.mkdirSync(workflowsDir, { recursive: true });
}

function sanitizeWorkflow(wf) {
    // 移除會頻繁變動但與流程邏輯無關的 metadata
    delete wf.updatedAt;
    delete wf.createdAt;
    delete wf.versionId;
    delete wf.versionCounter;

    // 清理共用權限設定中，各種會頻繁變動的 metadata
    if (Array.isArray(wf.shared)) {
        for (const share of wf.shared) {
            delete share.createdAt;
            delete share.updatedAt;
            if (share.project) {
                delete share.project.createdAt;
                delete share.project.updatedAt;
                if (Array.isArray(share.project.projectRelations)) {
                    for (const relation of share.project.projectRelations) {
                        delete relation.createdAt;
                        delete relation.updatedAt;
                        if (relation.user) {
                            delete relation.user.createdAt;
                            delete relation.user.updatedAt;
                            delete relation.user.lastActiveAt;
                        }
                    }
                }
            }
        }
    }
}

async function syncWorkflows() {
    console.log(`Connecting to ${apiUrl} to sync workflows...`);
    try {
        const response = await fetch(`${apiUrl}/api/v1/workflows`, {
            headers: { 'X-N8N-API-KEY': apiKey }
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();
        let workflows = data.data;

        if (!includeArchived) {
            workflows = workflows.filter(wf => !wf.isArchived);
        }

        console.log(`Found ${workflows.length} workflows to sync.`);

        for (const wf of workflows) {
            const filename = wf.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase() + `_${wf.id}.json`;
            const filePath = path.join(workflowsDir, filename);
            
            const wfResponse = await fetch(`${apiUrl}/api/v1/workflows/${wf.id}`, {
                headers: { 'X-N8N-API-KEY': apiKey }
            });
            const fullWf = await wfResponse.json();
            
            // 在存檔前進行過濾
            sanitizeWorkflow(fullWf);
            
            fs.writeFileSync(filePath, JSON.stringify(fullWf, null, 2));
            console.log(`Synced: ${filename}`);
        }
        console.log("Sync complete!");
    } catch (err) {
        console.error("Error syncing workflows:", err);
    }
}

syncWorkflows();
