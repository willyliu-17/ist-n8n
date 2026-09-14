# 摘要 Slack reaction 目標

`AI SUMMARY v3` 的 reaction 標記觸發該次摘要的訊息，回覆 thread 與 reaction 目標分別處理。

| 來源 | Reaction 目標 | 摘要回覆位置 |
| --- | --- | --- |
| `Collect suspect streamID v3` | 「自動化檢測詳情」根訊息 | 該根訊息的 thread |
| Channel 內直接輸入 `!summary stream …` | 指令主訊息 | 該指令的 thread |
| Thread 內輸入 `!summary stream …` | 該則指令 comment | 原有 thread |

## 資料來源

- 手動入口的 `standalone_summary` 與 `single_stream_summary` 已將指令訊息 `ts` 保存於 `requestKey`：`bot-summary:<指令 ts>:<stream ID>[:<stream ID>]`。
- `requestKey` 隨摘要請求持久化，`Map Summary Reactions` 從已讀取的請求資料列解析出 `reactionTargetTS`，非同步處理及重試使用同一目標。
- 自動檢測及既有非手動請求使用資料列的 `threadTS`。
- `Add Summary Reaction` 使用 `reactionTargetTS`；訊息與檔案回覆繼續使用 `threadTS`。
- 手動請求的 `requestKey` 若不符合格式，解析會失敗，不會退回根訊息。

## 驗證與部署範圍

回歸測試涵蓋 channel／thread 的單場與雙場指令、持久化後的目標解析、重試 carrier、實際 Code node 輸出及 Slack timestamp expression、自動檢測根訊息與無效 request key。

本修正只需部署 `AI SUMMARY v3`，不需新增資料表欄位。部署不會搬移已存在的 reaction，也不會重新執行已完成的摘要。
