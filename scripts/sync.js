const fs = require('fs');
const path = require('path');
const readline = require('readline');

const apiUrl = process.env.REMOTE_N8N_API_URL;
const apiKey = process.env.REMOTE_N8N_API_KEY;
const includeArchived = process.argv.includes('--include-archived');
const noUnpack = process.argv.includes('--no-unpack');

// 取得除了 flag 以外的參數
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));

if (!apiUrl || !apiKey) {
    console.error("Missing REMOTE_N8N_API_URL or REMOTE_N8N_API_KEY in .env");
    process.exit(1);
}

const workflowsDir = path.join(__dirname, '..', 'workflows');
if (!fs.existsSync(workflowsDir)) {
    fs.mkdirSync(workflowsDir, { recursive: true });
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

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

function getSafeName(name) {
    return name.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

async function getTargetWorkflows() {
    console.log(`Connecting to ${apiUrl} to sync workflows...`);
    const response = await fetch(`${apiUrl}/api/v1/workflows`, {
        headers: { 'X-N8N-API-KEY': apiKey }
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const data = await response.json();
    let workflows = data.data;

    if (!includeArchived) {
        workflows = workflows.filter(wf => !wf.isArchived);
    }
    
    return workflows;
}

async function resolveWorkflowTargets(allWorkflows) {
    if (args.length === 0) {
        return allWorkflows;
    }

    const targets = [];
    
    for (const arg of args) {
        let targetName = arg;
        
        // 檢查是否為路徑
        const potentialPath = path.resolve(arg);
        if (fs.existsSync(potentialPath)) {
            let jsonPath = potentialPath;
            if (fs.statSync(potentialPath).isDirectory()) {
                jsonPath = path.join(potentialPath, 'workflow.json');
            }
            if (fs.existsSync(jsonPath)) {
                try {
                    const localWf = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                    targetName = localWf.name;
                    console.log(`Resolved path ${arg} to workflow name: "${targetName}"`);
                } catch (e) {
                    console.error(`Failed to parse ${jsonPath}`);
                    continue;
                }
            }
        }

        // 在遠端找符合名稱的 workflow
        const matchingWorkflows = allWorkflows.filter(wf => wf.name === targetName);
        
        if (matchingWorkflows.length === 0) {
            console.log(`⚠️  Workflow "${targetName}" not found on the remote server.`);
        } else if (matchingWorkflows.length === 1) {
            targets.push(matchingWorkflows[0]);
        } else {
            console.log(`\n⚠️  在遠端找到多個名為 "${targetName}" 的工作流程：`);
            matchingWorkflows.forEach((wf, index) => {
                console.log(`[${index + 1}] ID: ${wf.id} (Name: ${wf.name})`);
            });
            console.log(`[0] 取消同步此工作流程`);
            
            while (true) {
                const answer = await askQuestion(`\n請選擇要同步哪一個 ID (輸入數字): `);
                const choice = parseInt(answer.trim(), 10);
                if (choice === 0) {
                    console.log(`已跳過 "${targetName}"`);
                    break;
                } else if (choice > 0 && choice <= matchingWorkflows.length) {
                    targets.push(matchingWorkflows[choice - 1]);
                    break;
                } else {
                    console.log("❌ 無效的選擇，請重新輸入。");
                }
            }
        }
    }
    
    // 移除重複的 target
    const uniqueTargets = [];
    const seenIds = new Set();
    for (const t of targets) {
        if (!seenIds.has(t.id)) {
            seenIds.add(t.id);
            uniqueTargets.push(t);
        }
    }
    return uniqueTargets;
}

async function syncWorkflows() {
    try {
        const allWorkflows = await getTargetWorkflows();
        const workflowsToSync = await resolveWorkflowTargets(allWorkflows);

        console.log(`\nFound ${workflowsToSync.length} workflows to sync.`);

        for (const wf of workflowsToSync) {
            const safeName = getSafeName(wf.name);
            const newBaseFilename = `${safeName}_${wf.id}`;
            let targetDirName = newBaseFilename;
            let targetId = wf.id;
            
            // 尋找本地是否已經有同名的 workflow 資料夾
            const existingDirs = fs.readdirSync(workflowsDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory() && dirent.name.startsWith(`${safeName}_`))
                .map(dirent => dirent.name);
            
            const exactMatch = existingDirs.find(d => d === newBaseFilename);
            const conflictDirs = existingDirs.filter(d => d !== newBaseFilename);

            if (!exactMatch && conflictDirs.length > 0) {
                const existingDir = conflictDirs[0]; // 取第一個找到的
                const existingIdMatch = existingDir.match(/_([a-zA-Z0-9A-Za-z]+)$/);
                const existingId = existingIdMatch ? existingIdMatch[1] : 'unknown';

                console.log(`\n⚠️  發現本地已存在同名的工作流程資料夾，但 ID 不同：`);
                console.log(`遠端來源: "${wf.name}" (ID: ${wf.id})`);
                console.log(`本地現存: workflows/${existingDir} (ID: ${existingId})`);
                
                let decision = '';
                while (!['O', 'N', 'S'].includes(decision)) {
                    const answer = await askQuestion(`\n請選擇處理方式：\n[O] 覆蓋現有 (Overwrite)：直接更新本地 ${existingDir} 的內容，並強制保留原有的 ID (${existingId})\n[N] 建立全新 (New)      ：保留原有資料夾，額外建立一個 ${newBaseFilename} 資料夾\n[S] 跳過 (Skip)         ：不要同步這個工作流程\n\n請選擇 [O/N/S]: `);
                    decision = answer.trim().toUpperCase();
                }

                if (decision === 'S') {
                    console.log(`已跳過 ${wf.name}`);
                    continue;
                } else if (decision === 'O') {
                    targetDirName = existingDir;
                    targetId = existingId;
                    console.log(`將覆寫本地 ${targetDirName}，並強制保留 ID: ${targetId}`);
                } else if (decision === 'N') {
                    targetDirName = newBaseFilename;
                    targetId = wf.id;
                    console.log(`將建立全新資料夾 ${targetDirName}`);
                }
            }
            
            // 抓取完整 Workflow
            const wfResponse = await fetch(`${apiUrl}/api/v1/workflows/${wf.id}`, {
                headers: { 'X-N8N-API-KEY': apiKey }
            });
            const fullWf = await wfResponse.json();
            
            // 強制設定 ID (如果選擇 Overwrite 會改寫為原有的 Prod ID)
            fullWf.id = targetId;

            // 在存檔前進行過濾
            sanitizeWorkflow(fullWf);
            
            if (noUnpack) {
                const workflowJsonPath = path.join(workflowsDir, `${targetDirName}.json`);
                fs.writeFileSync(workflowJsonPath, JSON.stringify(fullWf, null, 2));
                console.log(`Synced: ${targetDirName}.json`);
            } else {
                const wfDir = path.join(workflowsDir, targetDirName);
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
                console.log(`Synced and extracted: ${targetDirName}/workflow.json`);
            }
        }
        console.log("\nSync complete!");
    } catch (err) {
        console.error("Error syncing workflows:", err);
    } finally {
        rl.close();
    }
}

syncWorkflows();
