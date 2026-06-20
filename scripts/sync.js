const fs = require('fs');
const path = require('path');

const apiUrl = process.env.REMOTE_N8N_API_URL;
const apiKey = process.env.REMOTE_N8N_API_KEY;
const includeArchived = process.argv.includes('--include-archived');
const noUnpack = process.argv.includes('--no-unpack');

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
            
            const wfResponse = await fetch(`${apiUrl}/api/v1/workflows/${wf.id}`, {
                headers: { 'X-N8N-API-KEY': apiKey }
            });
            const fullWf = await wfResponse.json();
            
            // 在存檔前進行過濾
            sanitizeWorkflow(fullWf);
            
            if (noUnpack) {
                const workflowJsonPath = path.join(workflowsDir, `${baseFilename}.json`);
                fs.writeFileSync(workflowJsonPath, JSON.stringify(fullWf, null, 2));
                console.log(`Synced: ${baseFilename}.json`);
            } else {
                const wfDir = path.join(workflowsDir, baseFilename);
                if (!fs.existsSync(wfDir)) {
                    fs.mkdirSync(wfDir, { recursive: true });
                }

                // Extract code from nodes
                if (fullWf.nodes && Array.isArray(fullWf.nodes)) {
                    for (const node of fullWf.nodes) {
                        if (!node.parameters) continue;
                        
                        const extractionMappings = [
                            // 舊有程式碼邏輯 (無條件抽出)
                            { typeRegex: /^n8n-nodes-base\.code$/, fieldPath: ['parameters', 'jsCode'], ext: 'js', alwaysExtract: true },
                            { typeRegex: /^n8n-nodes-base\.code$/, fieldPath: ['parameters', 'pythonCode'], ext: 'py', alwaysExtract: true },
                            // 新增的文字欄位抽取 (具備長度門檻)
                            { typeRegex: /^n8n-nodes-base\.slack$/, fieldPath: ['parameters', 'text'], ext: 'md' },
                            { typeRegex: /^@n8n\/n8n-nodes-langchain\..*$/, fieldPath: ['parameters', 'text'], ext: 'md' },
                            { typeRegex: /^@n8n\/n8n-nodes-langchain\..*$/, fieldPath: ['parameters', 'options', 'systemMessage'], ext: 'md' },
                            { typeRegex: /^n8n-nodes-base\.(googleBigQuery|postgres)$/, fieldPath: ['parameters', 'sqlQuery'], ext: 'sql' },
                            { typeRegex: /^n8n-nodes-base\.(googleBigQuery|postgres)$/, fieldPath: ['parameters', 'query'], ext: 'sql' },
                            { typeRegex: /^@n8n\/n8n-nodes-langchain\.outputParserStructured$/, fieldPath: ['parameters', 'inputSchema'], ext: 'json' },
                            { typeRegex: /^n8n-nodes-base\.httpRequest$/, fieldPath: ['parameters', 'jsonBody'], ext: 'jsonc' },
                            { typeRegex: /^n8n-nodes-base\.set$/, fieldPath: ['parameters', 'jsonOutput'], ext: 'jsonc' }
                        ];

                        for (const mapping of extractionMappings) {
                            if (mapping.typeRegex.test(node.type)) {
                                let parent = node;
                                const keyName = mapping.fieldPath[mapping.fieldPath.length - 1];
                                
                                // 導航至目標屬性的父物件
                                for (let i = 0; i < mapping.fieldPath.length - 1; i++) {
                                    if (parent && parent[mapping.fieldPath[i]] !== undefined) {
                                        parent = parent[mapping.fieldPath[i]];
                                    } else {
                                        parent = undefined;
                                        break;
                                    }
                                }
                                
                                if (parent && typeof parent[keyName] === 'string') {
                                    const val = parent[keyName];
                                    const lines = val.split('\n').length;
                                    const chars = val.length;
                                    
                                    // 長度門檻：大於10行或大於200字元，或是被強制標記為 alwaysExtract (針對 jsCode/pythonCode)
                                    if (mapping.alwaysExtract || lines > 10 || chars > 200) {
                                        const safeNodeName = node.name.replace(/[^a-z0-9_]/gi, '_');
                                        const nodeDir = path.join(wfDir, 'nodes', safeNodeName);
                                        if (!fs.existsSync(nodeDir)) {
                                            fs.mkdirSync(nodeDir, { recursive: true });
                                        }
                                        
                                        const fieldSuffix = mapping.fieldPath.slice(1).join('_'); // e.g. options_systemMessage 或 jsCode
                                        const codeFilePath = path.join(nodeDir, `${fieldSuffix}.${mapping.ext}`);
                                        fs.writeFileSync(codeFilePath, val);
                                        
                                        // Replace with pointer
                                        parent[keyName] = `__EXTERNAL_FILE__://nodes/${safeNodeName}/${fieldSuffix}.${mapping.ext}`;
                                    }
                                }
                            }
                        }
                    }
                }

                const workflowJsonPath = path.join(wfDir, 'workflow.json');
                fs.writeFileSync(workflowJsonPath, JSON.stringify(fullWf, null, 2));
                console.log(`Synced and extracted: ${baseFilename}/workflow.json`);
            }
        }
        console.log("Sync complete!");
    } catch (err) {
        console.error("Error syncing workflows:", err);
    }
}

syncWorkflows();
