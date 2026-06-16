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
            const baseFilename = wf.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase() + `_${wf.id}`;
            const wfDir = path.join(workflowsDir, baseFilename);
            
            const wfResponse = await fetch(`${apiUrl}/api/v1/workflows/${wf.id}`, {
                headers: { 'X-N8N-API-KEY': apiKey }
            });
            const fullWf = await wfResponse.json();
            
            // 在存檔前進行過濾
            sanitizeWorkflow(fullWf);
            
            if (!fs.existsSync(wfDir)) {
                fs.mkdirSync(wfDir, { recursive: true });
            }

            // Extract code from nodes
            if (fullWf.nodes && Array.isArray(fullWf.nodes)) {
                for (const node of fullWf.nodes) {
                    if (!node.parameters) continue;
                    
                    const codeFields = [
                        { key: 'jsCode', ext: 'js' },
                        { key: 'pythonCode', ext: 'py' }
                    ];

                    for (const field of codeFields) {
                        if (node.parameters[field.key]) {
                            const safeNodeName = node.name.replace(/[^a-z0-9_]/gi, '_');
                            const nodeDir = path.join(wfDir, 'nodes', safeNodeName);
                            if (!fs.existsSync(nodeDir)) {
                                fs.mkdirSync(nodeDir, { recursive: true });
                            }
                            
                            const codeFilePath = path.join(nodeDir, `${field.key}.${field.ext}`);
                            fs.writeFileSync(codeFilePath, node.parameters[field.key]);
                            
                            // Replace with pointer
                            node.parameters[field.key] = `__EXTERNAL_FILE__://nodes/${safeNodeName}/${field.key}.${field.ext}`;
                        }
                    }
                }
            }

            const workflowJsonPath = path.join(wfDir, 'workflow.json');
            fs.writeFileSync(workflowJsonPath, JSON.stringify(fullWf, null, 2));
            console.log(`Synced and extracted: ${baseFilename}/workflow.json`);
        }
        console.log("Sync complete!");
    } catch (err) {
        console.error("Error syncing workflows:", err);
    }
}

syncWorkflows();
