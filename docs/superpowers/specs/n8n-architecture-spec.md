# n8n Git-Centric Architecture & Deployment Specification

本文件定義了如何安全且高效地透過 Opencode 與 n8n-mcp 管理 n8n 遠端 (Production) 與本地 (Local) 工作流程。核心精神為「Git-Centric (單一真相來源)」與「Local Sandbox (本地沙盒化)」。

---

## 決策：核心架構原則 (Core Principles)
<!-- HAI: decision #spec.core-principles mode=multi -->

> 推薦：全部選取以確立安全邊界

- [x] local_sandbox — **Local Sandbox**：`opencode.json` 的 MCP 設定永遠只指向 `http://localhost:5678`。Opencode Agent 不具備直接修改遠端 n8n 的權限。
- [x] git_truth — **Git as Source of Truth**：專案目錄下的 `workflows/` 資料夾永遠代表遠端 (Production) 的預期狀態。所有變更必須先進入 Git，再同步至遠端。
- [x] decoupled_auth — **權限抽離**：遠端的 `N8N_API_URL` 與 `N8N_API_KEY` 將獨立儲存於 `.env.remote` 中，並透過 `.gitignore` 排除，僅供獨立的 Node.js 腳本讀取。

---

## 決策：輔助腳本設計 (Auxiliary Scripts)
<!-- HAI: decision #spec.scripts mode=multi -->

> 推薦：全部選取以確立自動化流程

- [x] sync_script — **`scripts/sync.js`**：讀取 `.env.remote`，從遠端下載所有 workflow 覆蓋至 `workflows/`。**自動過濾排除已封存 (Archived) 的 workflow**。下載後檔名格式為 `[name]_[id].json`。
- [x] deploy_script — **`scripts/deploy.js <file>`**：讀取 `.env.remote`，將指定的 local JSON 檔案內容，透過 API 覆寫至遠端對應 ID 的 workflow。

---

## 決策：標準開發流程 (SOP)
<!-- HAI: decision #spec.workflow-sop mode=multi -->

> 推薦：全部選取以規範 Agent 行為

- [x] step_sync — **1. 同步 (Sync)**：執行 `node scripts/sync.js`，並透過 Git 確認遠端是否有外部更改。
- [x] step_dev — **2. 開發 (Dev)**：Agent 透過 `n8n-mcp` 在 Local n8n 進行開發與測試。
- [x] step_export — **3. 匯出 (Export)**：開發完成後，將 Local 的變更覆蓋至 `workflows/` 下的對應檔案，產生 Git 變更。
- [x] step_review — **4. 審查 (Review)**：(見下一節的詳細規範)
- [x] step_deploy — **5. 部署 (Deploy)**：審核通過後，執行 `node scripts/deploy.js` 將變更推上遠端。

---

## 決策：基於 HAI 的部署審核機制 (Deployment Audit via HAI)
<!-- HAI: decision #spec.deployment-audit mode=multi -->

> 推薦：確保每次部署前都有互動式的安全確認

- [x] diff_generation — **Diff 產生**：準備部署前，Agent 必須先擷取變更檔案的 `git diff`。
- [x] hai_presentation — **HAI 呈現**：Agent 必須將 Diff 內容與部署計畫寫入一個獨立的 Markdown 檔，並使用 HAI 腳本轉換成 HTML 介面交由人類審核。
- [x] explicit_approval — **明確授權**：人類使用者在 HTML 介面上點擊確認 (Feedback action=update) 並回傳後，Agent 才獲准執行 `deploy.js`。

---

## 決策：建立 AGENTS.md 守則
<!-- HAI: decision #spec.agents-md mode=multi -->

> 推薦：將上述規範化為 Agent 的系統提示

- [x] write_rules — 當上述架構（腳本、資料夾結構）皆建置並測試完畢後，將這些流程與「必須使用 HAI 呈現 Diff」的強制規定，寫入 `AGENTS.md` 作為最高指導原則。