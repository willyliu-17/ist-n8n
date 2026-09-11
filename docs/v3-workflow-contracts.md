# V3 工作流程契約備註

使用者在本次 HAI 審查後確認：以 Production 最新儲存的 workflow 定義為準，包含空的 description；Firebase 支線保留同事的修改，不自行補接或發布。

原本 13 個 description 中的重要輸入、輸出與副作用說明已移存至 [`v3-workflow-contracts.json`](v3-workflow-contracts.json)，以 canonical workflow ID 索引，保留原英文契約文字供文件檢查使用。

這些備註不會被 sync／deploy 自動寫回 workflow.description。工作流程的共同 description 仍以同步所得內容為準；契約文件與 workflow 設定分開維護。

## 重要契約

- STT presentation 以必填的 `attemptKey` 查詢持久化狀態，可能上傳檔案並更新 Slack 狀態。
- Slack 上傳成功但檢查點寫入失敗時，後續修復可能造成重複上傳；不得把這段行為宣稱為 exactly-once。
- Dispatcher 的 callback 網址仍須由目標環境設定解析，並保留固定 webhook 路徑。
- Summary orchestrator／coordinator 仍依 canonical rows、lease、CAS 及回讀驗證決定後續副作用。
- Collector 先發布 STT 與日誌收集狀態，再非同步呼叫 Summary orchestrator；附件傳送仍採 best-effort。
- 自動 repair 不負責替使用者核准 manual review；既有獨立核准界線維持不變。

## 驗證方式

原本檢查 description 中必要契約文字的測試改為讀取上述 JSON。輸入映射、資料驗證、lease、CAS、回讀與傳送順序等行為測試仍直接檢查 workflow／程式碼，沒有改成只檢查文件。
