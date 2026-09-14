# v3 單場整場摘要

## 指令

```text
!summary stream <liveStreamID>
!summary stream <liveStreamID> date=YYYY-MM-DD
!stt stream <liveStreamID>
!stt stream <liveStreamID> date=YYYY-MM-DD
```

單一 ID 會建立 `single_stream_summary` 請求，從直播起點轉錄到實際關播時間。直播必須具有有效開關播時間與非空 `closeBy`，尚未關播或查不到 metadata 時不提交 STT。

`!stt stream <liveStreamID>` 省略片段模式時，與單場 summary 共用整場轉錄加摘要流程。明確指定 `first/last [mins]` 時則保留片段 STT；省略分鐘數時為 5 分鐘。

雙 ID 指令使用前場最後 5 分鐘、目前場最初 5 分鐘，再產生摘要。既有單場 suspect 不會自動改成整場模式。

## 日期窗口

片段 STT、整場 STT、單場與雙場 summary 指定日期時，皆使用台灣時間 04:00 日界線，包含指定日及前後各兩天，共 5 天，含起點、不含終點。帶日期時不 fallback，也不依直播開關播時間擴大窗口。

```text
date=2026-09-07
2026-09-05T04:00:00+08:00 <= beginTime
beginTime < 2026-09-10T04:00:00+08:00
```

未指定日期時，先查 `[執行當下 - 30 天, 執行當下)`；找不到目標時，再查 `[執行當下 - 60 天, 執行當下 - 30 天)`。兩個整場指令與片段 STT 均適用；雙場 summary 僅前場可以 fallback，目前場仍須在最近 30 天內。

窗口只用來依 ID 與開播時間尋找 metadata，不裁切 STT；整場分鐘數為 `ceil((endTime - beginTime) / 60)`，尾段由後端於實際關播時間截斷。單場 fallback 仍只尋找同一個 ID，不自動配對另一場直播。

## 等待與重試

- STT API 接受單場請求後，callback 等待期限為接受時間起 150 分鐘。
- 等待期間不依舊 Summary 的短間隔重送，避免建立多個 SegmentTask。
- 明確可重試的 HTTP 提交錯誤沿用有界重試；提交結果不明的網路錯誤仍進入人工確認。
- 新模式的 callback service failure 或等待逾期會終止該 attempt，不自動建立另一個整場轉錄任務。
- 已消費 callback 的重複處理、canonical linkage 與 CAS 規則保持不變。
- 空轉錄保留 `empty` outcome；它表示服務已完成但沒有辨識文字，不代表沒有問題。
- timeout 可依既有 coordinator 規則產出 partial 技術分析，但 prompt 必須明示沒有完整對話證據。

依後端契約，首次下載、轉檔、Whisper 與留言對齊可能耗時很久；後端另有兩小時未完成即 timeout 的硬限制。150 分鐘只避免呼叫端提早放棄，不能解除後端限制。

## 推論與長對話

父工作流程只對 `single_stream_summary` 傳入 `analysisMode: single_stream_full`。共用 inference 子流程在未指定模式時仍採原本的分析方式，`evalConfig` 的原用途不變。

單場 prompt 只分析本場，不預設中斷、前場或重開；恢復狀態描述本場內有證據的恢復，跨場恢復不適用。JSON required fields 與 enum 保持不變，只有新模式的描述改變。新模式最終輸出也會遮蔽文字中的 IPv4／IPv6 位址。

長對話採有界文字 map/reduce，不切音檔、不重送 STT：

| 保護項目 | 目前限制 |
| --- | --- |
| 原始 aggregate 可直接分析的容量 | 128 KiB UTF-8 JSON |
| 每個對話分段 | 32 KiB UTF-8，包含來源標頭 |
| 分段數量 | 最多 12，且必須通過合併預算預檢 |
| 每段模型輸出 | 8 KiB，必須包含完成標記 |
| 合併後 aggregate | 128 KiB UTF-8 JSON |

這些是保守的 payload 預算，不是精準 token 計數。預檢會另外保留 map 結果與來源清單的空間；因此不是任何 12 段輸入都能通過。log 本身過大、分段過多或沒有足夠合併空間時會明確失敗，不截掉原文假裝成功。

每個分段保留原文位置與可識別的時間背景。收集階段透過 n8n item linkage 對應實際分段，驗證每段都有結果、來源範圍連續且覆蓋完整原文，再綜合分析。報告須說明使用分段證據，不宣稱主 Agent 直接閱讀全部原文。

## 驗證與部署

```bash
node --test scripts/single-stream-summary-v3.test.js
node --test scripts/stt-summary-stream-behavior.test.js
node --test workflows/ai_summary_inference_subwf_m8VcIoclFE2lVKrl/tests/inference.test.js workflows/ai_summary_inference_subwf_m8VcIoclFE2lVKrl/tests/long-dialogue.test.js
node scripts/verify-stt-summary-v3.js
```

離線測試涵蓋指令至推論輸入契約、舊模式回歸、期限、分段完整性與 prompt/schema。這不等於已驗證真實 STT 效能、Vertex 模型可用性或報告品質。

部署包含入口、orchestrator、dispatcher、callback、repair scheduler／processor、AI SUMMARY v3 與共用 inference 子流程。共用 inference 必須先具備新模式與分段節點，再開放入口新指令。Data Table schema 不需遷移。

部署與真實測試須另外確認目標環境並取得批准；本機檔案變更不代表已上線。
