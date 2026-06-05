# 全新 Git-Centric 架構規劃

## 決策：全新 Git-Centric 架構規劃
<!-- HAI: decision #plan.git-centric-architecture mode=multi -->

> 推薦：全部選取以作為新架構基礎

- [x] sandboxed — **AI Sandboxed**：`opencode.json` 的 MCP 設定永遠只綁定 Local n8n，廢除環境切換機制，確保 Prod 安全。
- [x] scripts — **輔助腳本**：建立 `scripts/sync.js` 與 `scripts/deploy.js` 專責處理與 Remote n8n 的互動。
- [x] filter — **過濾 Archive**：`sync.js` 預設排除 Archived workflows，確保 Git 目錄乾淨。
- [x] audit — **部署審核**：部署前必須呈現 `git diff`，並要求人工確認後才呼叫 `deploy.js`。
- [x] agents — **AGENTS.md (最後執行)**：待上述工具與腳本建立、測試完成後，最後再總結經驗寫入 `AGENTS.md`。