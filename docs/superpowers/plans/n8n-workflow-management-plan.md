# n8n Workflow 管理與環境配置規劃

## 決策：整理知識至 AGENTS.md
<!-- HAI: decision #plan.agents-md mode=multi -->

> 推薦：全部選取以作為 Agent 運作最高指導原則

- [x] target — 專案目標：說明使用 n8n-mcp 管理與開發 n8n Workflow。
- [x] architecture — 環境架構：說明 `opencode.local.json` 與 `opencode.remote.json` 的 Symlink 管理方式。
- [x] audit — 審核機制：Agent 必須經人工審核後才可對 n8n 進行寫入。
- [x] sync — 同步機制：不需重啟 Opencode 的 Sync Workflow 腳本使用方式。

## 決策：建立 Git Repository
<!-- HAI: decision #plan.git-repo mode=multi -->

> 推薦：全部選取以納入版本控制

- [x] init — 執行 `git init`。
- [x] gitignore — 確認 `.gitignore` (已排除機密設定與捷徑)。
- [x] commit — 建立初始 Commit (`chore: initial n8n workspace setup`) 包含所有 workflows。

## 決策：切換環境與測試規則 (SOP)
<!-- HAI: decision #plan.env-sop mode=multi -->

> 推薦：落實 Local-First 開發流程

- [x] local — Local-First：新功能與修改預設在 Local 端建立與測試。
- [x] switch — 環境切換限制：必須由使用者授權後才執行 `./switch-env.sh [env]`。
- [x] deploy — 部署至 Remote：須先展示 Diff 或更新計畫，人工審核後才允許執行。

## 決策：無須重啟的 Workflow 同步腳本
<!-- HAI: decision #plan.sync-script mode=multi -->

> 推薦：改寫現有腳本，支援帶入參數切換 API 來源

- [x] script — 建立 `sync_workflows.js` 支援讀取命令列參數 (例如 `node sync_workflows.js local` 或 `remote`)。
- [x] config — 腳本內部直接去讀取 `opencode.local.json` 或 `opencode.remote.json` 的設定，不依賴 `opencode.json` 捷徑。
- [x] split — 下載檔案分別存入 `workflows/local/` 與 `workflows/remote/` 兩個子目錄以利比對差異。