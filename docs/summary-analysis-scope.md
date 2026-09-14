# Summary 分析範圍與狀態驗證

## 輸入與相容性

`AI SUMMARY Inference SubWF` 在既有 `Long Dialogue Preflight` 節點建立可信 `analysisScope`，供主 Agent、四個 Analyzer 與報告驗證共用。單場長對話分段後，仍引用這份分段前的範圍。

| 欄位 | 意義 |
|---|---|
| `analysisMode` | `single_stream_full` 為指定本場完整分析；其他既有合法模式正規化為 `comparison` |
| `requestedStreams` | 請求的 ID 與角色；角色可為 `previous`、`current`、`unspecified` |
| `availableStreamIDs` | 至少具備對話文字、直播概況或日誌其中一類證據的場次 |
| `missingDialogueRoles` | 缺少對話的角色，不表示所有技術證據都缺失 |
| `coverageStatus` | V3 的對話覆蓋狀態；舊呼叫者未提供時為 `unknown` |

V3 呼叫端傳入所有請求場次、對話缺口與覆蓋狀態。缺少對話的場次仍保留其 ID 與角色，不因可用證據只剩一場而切換模式。

V2 與 Prompt Eval 可以省略新增的輸入欄位；子流程從 Aggregate 建立 ID 範圍，缺少角色時使用 `unspecified`，不推測前後順序，也不把單筆輸入自動視為單場完整分析。

## 模型與驗證

主 Agent 明確取得完整分析範圍。Analyzer 的固定要求與資料直接取自工作流程；模型只能提供 `analysisFocus`。若分析重點包含 ID 標籤或長數字，會略過該重點，避免將模型生成的 ID 誤當成使用者請求；原始日誌與資料不套用這個過濾。

模型輸出在原有 `report` 旁新增 `analysisScope`。驗證器會核對完整結構化範圍，包括模式、ID、角色、覆蓋狀態與陣列順序。JSON 物件欄位順序不影響比對。

另檢查明確的使用者請求／分析對象敘述，攔截本次事故中的錯誤 ID 句型。這是有限的文字檢查，不是完整自然語言事實驗證；日誌中提及其他 ID、指標或時間戳，不應被全面數字掃描誤擋。

錯誤碼：

- `summary_analysis_scope_invalid`：可信輸入範圍不合法或互相矛盾。
- `summary_analysis_scope_mismatch`：模型輸出範圍不符，或明確的分析對象敘述包含錯誤 ID。
- `summary_model_output_invalid`：沿用既有報告格式錯誤，包含解析器無法修正的輸出。

## 失敗與 Slack 狀態

推論失敗經父流程 `Sanitize Stage Error` 處理，沿用既有狀態寫入與重讀驗證：第一次等待一分鐘、第二次等待五分鐘，第三次為最終失敗。

新的順序是：

`Verify Failure → Build Failure Status → Update Summary Status Failure → Verify Failure Status Update → Return Result`

更新的是原本 `summaryMessageTS` 所指向的訊息。分析範圍驗證失敗會說明本次報告未發布；重新推論時顯示 `Retrying`。Slack 更新僅針對同一訊息重試最多三次，成功後比對 `ok`、channel 與訊息 timestamp。

缺少訊息 timestamp 會明確拋出 `summary_status_message_missing`；Slack 回應不符則拋出 `summary_failure_status_update_failed`。Slack API 重試用盡會停止該次 execution，沿用工作流程錯誤處理。已寫入的摘要失敗／重試狀態仍保留，不會因 Slack 更新失敗而被重設。最終失敗但 Slack 無法更新時，仍需依錯誤紀錄處理訊息；本次沒有新增自動補建訊息或狀態專用排程。

## 驗證與部署

本機回歸測試涵蓋本次事故 ID、單場、長對話、比較缺資料、範圍不符、合理日誌引用、舊呼叫端與 Slack 更新失敗。

```bash
node --test workflows/ai_summary_inference_subwf_m8VcIoclFE2lVKrl/tests/*.test.js workflows/ai_summary_v3_AISummaryV3A0001/tests/*.test.js
node scripts/verify-stt-summary-v3.js
```

離線測試不代替實際 n8n、Vertex 與 Slack 整合驗證。整合測試與部署須另行確認環境及副作用。部署時需核對父流程與推論子流程的相容版本；這次新增欄位不會重新驗證或重產已持久化的舊報告。
