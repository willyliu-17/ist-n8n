# n8n Git-Centric 架構與開發流程 (SPEC)

## 決策：架構設計原則
<!-- HAI: decision #spec.architecture mode=multi -->

> 推薦：確立 Git 作為唯一真相來源 (Source of Truth)

- [x] source_of_truth — **Git as Source of Truth**：`workflows/` 目錄內的 JSON 檔案永遠代表 Production (Remote) 的預期狀態。
- [x] local_sandbox — **Local Sandboxed AI**：Opencode (`opencode.json`) 內的 `n8n-mcp` 永遠只連線 `http://localhost:5678`。AI 不具備直接修改 Remote 系統的權限。
- [x] script_bridge — **自動化橋樑**：透過獨立的 `scripts/sync.js` 與 `scripts/deploy.js` 來進行 Local Git 目錄與 Remote n8n 之間的狀態同步。

## 決策：自動化腳本功能定義
<!-- HAI: decision #spec.scripts mode=multi -->

> 推薦：定義同步與部署腳本的行為準則

- [x] sync_logic — **`sync.js` 邏輯**：連線至 Remote n8n，下載所有 `active` 或非 `archived` 的 workflows，覆寫至 `workflows/` 目錄。若有變更，提示使用者 Commit。
- [x] deploy_logic — **`deploy.js` 邏輯**：讀取 `workflows/` 下指定的 JSON 檔案，連線至 Remote n8n 進行更新 (Update) 或建立 (Create)。
- [x] secret_management — **機密管理**：腳本所需之 Remote API Key 將透過環境變數或獨立的 `.env` / `opencode.remote.json` 讀取，絕對不進入版本控制。

## 決策：部署審核機制 (Deploy Audit)
<!-- HAI: decision #spec.audit mode=multi -->

> 推薦：將 Diff 視覺化整合入 HAI 流程

- [x] hai_diff — **互動式 Diff 審查**：當 AI 在 Local 修改完畢，準備將更新寫入 `workflows/` 準備部署時，AI 必須產生變更摘要，並透過 HAI HTML 介面呈現 (例如在 Comment 中附上主要修改邏輯)。
- [x] explicit_approval — **明確授權**：使用者透過 HAI 回傳 `action=update` 且帶有確認 Comment 後，AI 才能執行 `git commit` 以及呼叫 `deploy.js` 將變更推送到 Remote。

## 決策：AGENTS.md 規範內容
<!-- HAI: decision #spec.agents mode=multi -->

> 推薦：制定 AI 行為準則

- [x] define_roles — 明確定義 AI 的職責僅限於 Local 開發與測試。
- [x] enforce_sop — 強制 AI 在修改 workflow 前先進行 Context 探索 (Explore)，修改後必須先在 Local 測試通過。
- [x] enforce_hai — 強制 AI 在任何觸及 `workflows/` 目錄更新與呼叫 `deploy.js` 前，必須經過 HAI 授權流程。