# n8n 實體遷移指南 (舊主機至新主機)

本文件整理自舊主機（`https://34.144.237.1`，原 n8n Prod 實體）至新主機（`https://n8n-ist.17app.co` / `34.110.185.37`）的遷移作業盤點、架構分析與實作步驟，特別針對工作流程（Workflow）、憑證（Credential）與資料表（Data Table）之獨立處置方案進行規劃。

---

## 一、 現況背景與環境概述

### 1.1 主機環境對照

| 項目 | 舊主機 (Source / Old Prod) | 新主機 (Target / New Prod) |
| :--- | :--- | :--- |
| **存取路徑** | `https://34.144.237.1` | `https://n8n-ist.17app.co` |
| **底層 IP** | `34.144.237.1` | `34.110.185.37` (DNS 已指向此 IP) |
| **TLS 憑證狀態** | 憑證 SAN 為 `DNS:n8n-ist.17app.co` (直連 IP 需 bypass cert) | 憑證完全相符且受信任 |
| **資產現況** | 48 Workflows (35 Active), 11 Data Tables, 7 Tags | 0 Workflows, 0 Data Tables, 0 Tags (全新環境) |
| **運作現況** | 持續運行中（排程觸發正常跳動） | 尚未部署服務 |

### 1.2 新主機 API 權限驗證結果

透過 `.env_new` 的 API Key 針對新主機 Public API 進行端點實測，確認具備下列必要權限：
- `GET /api/v1/workflows`：HTTP 200 (讀取成功)
- `POST /api/v1/workflows`：HTTP 200 (建立成功，實測建立與刪除通過)
- `GET /api/v1/data-tables`：HTTP 200 (讀取成功)
- `POST /api/v1/data-tables`：HTTP 201 (建立成功，實測建立與刪除通過)
- `GET /api/v1/tags` / `POST /api/v1/tags`：HTTP 200 / 201 (讀取與建立成功)
- `GET /api/v1/executions`：HTTP 200 (讀取成功)
- `GET /api/v1/credentials`：HTTP 403 (預期安全限制；n8n Public API 預設不提供憑證導出，新舊機皆同)

---

## 二、 憑證與認證資產盤點專題 (Credentials & Auth - 【待處理】)

### 2.1 獨立處理原因與當前狀態
1. **安全機制限制**：n8n Public API 出於安全性考量，禁止外部讀取或匯出憑證機密明文（如 Token、Password、Service Account Private Key）。`GET /api/v1/credentials` 端點在舊機與新機均回傳 HTTP 403。
2. **ID 重新生成**：新主機上手動建立的憑證會獲配全新的內部 ID（UUID），節點參照必須依賴 `(type, name)` 進行自動映射（`scripts/deploy-utils.js` 之 `buildCredentialReferenceMap`）。
3. **當前狀態標記**：由於 Service Account 金鑰、API Token 與 Slack 授權等資產目前**尚未完成驗證**，以下列出之所有核心憑證皆標記為 **【待處理】**，需於新環境完成資產確認、權限驗證與手動配置。

### 2.2 核心活躍憑證詳情與相依性清單 (必備 5 項 - 全數【待處理】)

經全面掃描所有活躍工作流程節點，新機器必須完成建立以下 5 項核心憑證：

#### 1. 【待處理】GCP BigQuery Service Account (`Google BigQuery account`)
- **n8n 憑證名稱**：`Google BigQuery account`
- **n8n 憑證型別**：`googleApi` (Service Account JSON Key)
- **舊機憑證 ID**：`Dd7x1TQhh9YKbD8v`
- **目標 GCP 專案**：`media17-1119`
- **必要權限 (IAM Roles)**：
  - `roles/bigquery.jobUser` (於專案執行 BigQuery Job)
  - `roles/bigquery.dataViewer` (讀取 `MatomoDataSource`, `MatomoCore`, `StreamerLog`, `MatomoDataMart` 等 Dataset)
- **相依節點與規模**：共使用於 **44 個節點**，涵蓋 **12 個活躍工作流程**（包含 `Collect suspect streamID v3`, `Query Steam Logs v3`, `Stream Metadata: resolve by IDs v3`, `Tencent realtime VDS v3`, `AI SUMMARY v3` 等核心 V3 流程）。
- **待驗證項目**：確認專用 Service Account JSON 金鑰檔案是否完備，並驗證該 SA 在 `media17-1119` 執行 SQL 查詢無權限阻礙。

#### 2. 【待處理】GCP Vertex AI Service Account (`Vertex SA`)
- **n8n 憑證名稱**：`Vertex SA`
- **n8n 憑證型別**：`googleApi` (Service Account JSON Key)
- **舊機憑證 ID**：`xCxzQVNUYMaL9Cea`
- **目標 GCP 專案**：`aiops-338206`
- **目標呼叫模型**：Vertex AI Model Garden 之 `gemini-2.5-flash`、`gemini-2.5-pro`
- **必要權限 (IAM Roles)**：
  - `roles/aiplatform.user` (Vertex AI User 呼叫模型推論)
- **相依節點與規模**：共使用於 **3 個核心節點**，涵蓋 **1 個核心活躍工作流程**：
  - `AI SUMMARY Inference SubWF`（節點：`Vertex Gemini-2.5-flash Chunk Map`, `Vertex Gemini-2.5-flash`, `Vertex gemini pro`）
- **待驗證項目**：確認具備專案 `aiops-338206` 權限之 Service Account 金鑰，並測試能否正常調用 Vertex AI Gemini 2.5 flash/pro 端點。

#### 3. 【待處理】STT API Header Auth (`Header Auth account 2`)
- **n8n 憑證名稱**：`Header Auth account 2`
- **n8n 憑證型別**：`httpHeaderAuth`
- **舊機憑證 ID**：`b39tXWu6AGQsbY2C`
- **目標服務端點**：`https://stt-api.17app.co/api/v1/stream/conversions/segment`
- **憑證 Header 定義**：自訂 HTTP 標頭（例如 `Authorization: Bearer <token>` 或 `X-API-KEY: <key>`）
- **相依節點與規模**：共使用於 **4 個節點**，涵蓋 **4 個活躍工作流程**（包含核心 `STT: dispatch attempt v3` 之 `STT Service: Dispatch Attempt` 節點）。
- **待驗證項目**：確認 STT 服務 API Token 密鑰明文，並測試自新主機發起分段轉檔 POST 請求是否通過認證。

#### 4. 【待處理】Slack Bot OAuth Token (`n8n-streaming-testing`)
- **n8n 憑證名稱**：`n8n-streaming-testing`
- **n8n 憑證型別**：`slackApi`
- **舊機憑證 ID**：`9sfslX7caXSFAVUN`
- **目標平台**：17LIVE 內部 Slack Workspace (Bot User OAuth Token, 開頭為 `xoxb-`)
- **必要權限 (OAuth Scopes)**：
  - `chat:write`, `chat:write.public`, `reactions:write`, `files:write`, `users:read`, `channels:read`
- **相依節點與規模**：共使用於 **76 個節點**，涵蓋 **20 個活躍工作流程**（包含 IST Bot 核心入口 `IST bot entry v3`, `IST bot Slack ingress v3`、摘要回調 `Summary: coordinator v3`、歷史事件查詢 `History: deliver one v1` 等）。
- **待驗證項目**：確認 Slack Bot Token 是否仍具備足夠效期與 Scopes，並於新環境建立同名憑證後向測試頻道發送訊息驗證。

#### 5. 【待處理】Google Gemini (PaLM) API Key (`Google Gemini(PaLM) Api account`)
- **n8n 憑證名稱**：`Google Gemini(PaLM) Api account`
- **n8n 憑證型別**：`googlePalmApi`
- **舊機憑證 ID**：`gMeMxD0Uq89xl8xy`
- **目標平台**：Google AI Studio API Key (開頭為 `AIza...`)
- **目標呼叫模型**：`gemini-1.5-flash`, `gemini-pro` 等輕量輔助模型
- **相依節點與規模**：共使用於 **14 個節點**，涵蓋 **6 個活躍工作流程**（包含 `STT result listener v3`, `Tencent realtime VDS v3`, `AI SUMMARY v3` 等）。
- **待驗證項目**：準備可用的 Google AI Studio API Key 並建立至新環境。

---

### 2.3 歷史殘留與免處理憑證說明

經全面代碼審查與版本對比，下列憑證確認為歷史遺留或已被 V3 新架構取代，**新機器無需建立**：

| 憑證名稱 | 憑證型別 | 歷史背景與免處理原因 |
| :--- | :--- | :--- |
| `GDrive token` | `httpCustomAuth` | 雖名為 GDrive，但節點實際請求的是 STT API，且僅存在於已停用之 V1/V2 歷史流程中。V3 全面改用 `Header Auth account 2`，故**無需遷移**。 |
| `STT callback auth` | `httpBasicAuth` | 舊版 V2 callback 的 Basic Auth。V3 回調已改用 `STT: callback ingress v3`，由資料表 `stt_jobs_v3` 之 token hash 驗證，故**無需遷移**。 |
| `Unnamed credential` | `oAuth2Api` | 僅存在於已廢棄且停用之 `Gdrive test` 實驗流程中，**無需遷移**。 |

---

### 2.4 憑證對接與映射機制
- 在新主機 Web UI（`Settings` -> `Credentials`）手動建立上述 5 個【待處理】憑證。
- **憑證名稱 (Name) 必須與上述清單一字不差完全一致**。
- `scripts/deploy-utils.js` 部署腳本已內建 `buildCredentialReferenceMap`，部署時會自動依據 `(type, name)` 將工作流程 JSON 內的舊機 UUID 置換為新機生成的全新 Credential UUID。

---

## 三、 資料表建立與資料列轉移專題 (Data Tables & Data Rows Migration)

新主機初始狀態為 0 個 Data Tables。**資料表結構（Schema）與既有資料列（Rows）皆必須完整遷移**，否則工作流程將無法正確部署且會引發系統副作用。

### 3.1 必需資料表資產盤點 (共 11 個表格，22,057 筆資料)

舊機器經實測盤點，共存在 11 個 Data Tables，累積總資料量為 **22,057 筆**：

| 資料表名稱 (Name) | 舊機 ID | 欄位數 | 舊機資料列數 (Rows) | 業務領域與主要用途 |
| :--- | :--- | :---: | :---: | :--- |
| `stt_jobs_v3` | `XcwbQCMt3kFKlT9m` | 44 | **8,025 筆** | STT 任務排程、進度狀態、回調 token 雜湊、重試租約與檢查點 |
| `automation_errors_v3` | `igPmXRy7rFFwNtPW` | 14 | **4,751 筆** | 系統錯誤事件隔離、重試標記與節點錯誤明細 |
| `AISummaryV2` | `Lx5XX1urLbFzXqpm` | 6 | **2,175 筆** | 歷史 V2 摘要過渡資料庫 |
| `streamer_history_event_streams_v1` | `bdCZlDjPvt7MwTpN` | 17 | **1,429 筆** | 主播事件與關聯串流資訊（OBS/設備/版本） |
| `streamer_history_analysis_categories_v1` | `FthMQzowrdg1E9E9` | 23 | **1,123 筆** | 摘要分析維度與完成時間證據 |
| `streamer_history_import_state_v1` | `J4gPSYGkjOoQD9Hh` | 22 | **1,076 筆** | 主播歷史導入進度 checkpoint 與時間水位線 (Watermark) |
| `summary_requests_v3` | `zteior3j5tfcX4hg` | 33 | **1,019 筆** | V3 摘要核心狀態機、分散式租約、CAS 鎖與推論結果 |
| `suspect_stt_candidates_v3` | `m2hfjroOqrQHhro0` | 12 | **1,009 筆** | 候選可疑串流追蹤與對應之 summaryRequestKey |
| `streamer_history_analyses_v1` | `nlhcQh5wY78SzHcj` | 27 | **728 筆** | 主播分析摘要 Markdown、fingerprint 與上傳 ID |
| `streamer_history_events_v1` | `ZPynJUrJLZuUnQiz` | 9 | **722 筆** | 主播歷史聚合事件身分與串流清單 |
| `streamer_history_reviews_v1` | `5SzS75aj7cqBXsck` | 14 | **0 筆** | 人工審查與覆核狀態表 |

### 3.2 為什麼資料列轉移 (Rows Migration) 不可或缺？

若只建立空資料表而未轉移既有資料列，系統將面臨重大業務風險：

1. **避免重複派工與外部 API 費用浪費 (Deduplication)**：
   - `suspect_stt_candidates_v3` 記錄了已排隊處理的可疑串流。若新主機為空表，排程掃描工作流程（如 `Collect suspect streamID v3`）會將歷史上已經轉檔過的舊串流判定為新事件，**重複向 STT API 請求切片轉檔，並重複呼叫 Gemini 大模型**，造成算力浪費與高額 API 費用。
2. **狀態機與分散式租約連續性 (State Machine Continuity)**：
   - `summary_requests_v3` 與 `stt_jobs_v3` 記錄了分散式租約（Lease Owner/Until）、回調檢查點與 token 雜湊（`callbackTokenHash`）。若非同步回調或重試機制在新主機運作時查無父請求，會導致回調被判定為孤兒事件（Orphan）而失敗。
3. **歷史資料導入水位線 (Watermark Continuity)**：
   - `streamer_history_import_state_v1` 存有 `watermarkUpdatedAtIso`。若表為空，Ingestion 流程將失去上次同步時間點，被迫從起點全量重新拉取歷史資料。
4. **Slack Bot 查詢連續性**：
   - Slack 機器人指令查詢主播歷史紀錄時，直接依賴 `streamer_history_analyses_v1` 與 `streamer_history_events_v1` 提供即時報表。若未轉移，使用者將立即發現查無歷史報告。

### 3.3 結構與欄位定義 (Schema)
- 權威欄位定義儲存於：
  `workflows/automation_provision_state_v3_AutomationProvV3A1/nodes/State_Schema/schema.json` 與 `scripts/streamer-history-schema.js`。
- 系統欄位規則：
  - n8n 系統自動欄位（`id`, `createdAt`, `updatedAt`）由伺服器自動維護，**在寫入與匯入時必須過濾剔除**。
  - 自訂業務欄位僅限基本型別：`string`, `number`, `boolean`。

### 3.4 資料轉移獨立工具 (`migration/migrate-data-tables.js`)

為確保例行維護與 CI 流程之乾淨，所有一次性遷移與資料轉移腳本已獨立收納於 `migration/` 目錄中，與日常運行的 `scripts/` 隔離：

```bash
# 1. 導出：從舊主機導出所有 Table 結構與 22,057 筆資料至 migration/data-tables-backup 目錄
SOURCE_N8N_API_URL="https://34.144.237.1" SOURCE_N8N_API_KEY="<舊機KEY>" NODE_TLS_REJECT_UNAUTHORIZED=0 node migration/migrate-data-tables.js --export migration/data-tables-backup

# 2. 乾跑預覽：預覽目標主機將建立的表格與即將匯入的筆數
TARGET_N8N_API_URL="https://n8n-ist.17app.co" TARGET_N8N_API_KEY="<新機KEY>" node migration/migrate-data-tables.js --import migration/data-tables-backup --dry-run

# 3. 匯入：在新主機自動建立缺失的資料表，並批次匯入資料列
TARGET_N8N_API_URL="https://n8n-ist.17app.co" TARGET_N8N_API_KEY="<新機KEY>" node migration/migrate-data-tables.js --import migration/data-tables-backup

# 4. 驗證：比對新舊兩端表格欄位與筆數是否完全一致
SOURCE_N8N_API_URL="https://34.144.237.1" SOURCE_N8N_API_KEY="<舊機KEY>" TARGET_N8N_API_URL="https://n8n-ist.17app.co" TARGET_N8N_API_KEY="<新機KEY>" NODE_TLS_REJECT_UNAUTHORIZED=0 node migration/migrate-data-tables.js --verify
```

---

## 四、 工作流程處理計畫 (Workflows - 需獨立處理)

### 4.1 遷移範圍與已歸檔流程排除 (Scope & Archived Exclusion)

- **已歸檔工作流程排除原則**：根據規範，舊機器上已標記為歸檔（`isArchived: true`）的工作流程**確定不進行搬移**。
  舊主機經實測共有 4 個已歸檔工作流程，全數排除於遷移清單之外：
  1. `main flow` (舊機 ID: `1wgxjjKgx2ug2Hmz`)
  2. `preferred streamer(API)` (舊機 ID: `8d9DrH3jpDNbb7Oa`)
  3. `test main flow` (舊機 ID: `f1iIBJ1mRZjE2Eby`)
  4. `multiple account detection(API)` (舊機 ID: `LXeoIDBoDYAoj4Cl`)
- **部署來源 (Source of Truth)**：
  - 本地 Git `workflows/` 目錄僅納管 44 個未歸檔工作流程（35 個 Active + 9 個 Inactive 輔助/測試流程）。
  - 所有 44 個資料夾經 Dry-Run 比對證實其商業邏輯、程式碼（JS / SQL / Markdown）與舊機非歸檔版本 **100% 一致**。
  - 遷移部署應直接以 Git 為唯一基準發布至新機器。

### 4.2 相依性分層與部署順序 (Deployment Phased Rollout)

由於新機器初始狀態無任何工作流程，直接發布頂層流程會因 `Execute Workflow` 找不到被呼叫的子流程而報錯。部署必須嚴格依照下列分層進行：

#### 第一層：獨立無依賴子流程 (Leaf Sub-workflows)
此層不呼叫其他 n8n 工作流程，僅處理純運算或外部 API/DB：
1. `Stream Metadata: resolve by IDs v3`
2. `Debug STT service`
3. `AI SUMMARY Inference SubWF`
4. `Automation: error handler v3`
5. `Repair: process candidate v3`
6. `History: lookup v1`
7. `History: write row v1`
8. `Query Steam Logs v3`
9. `Tencent realtime VDS v3`
10. `Slack Reaction Subworkflow`

#### 第二層：中階功能與協調子流程 (Middle Tier)
依賴第一層子流程與 Data Table：
1. `STT: dispatch attempt v3` (依賴 STT API、資料表)
2. `STT: callback ingress v3` (依賴 STT 回調狀態)
3. `STT result listener v3` (依賴 presentation 邏輯)
4. `Summary: orchestrate request v3` (依賴 Data Table 與下游)
5. `Summary: coordinator v3` (依賴 Orchestrator 與 Inference SubWF)
6. `History: deliver one v1` (依賴 Lookup 與 Write Row)
7. `History: import request v1` (依賴 Write Row)
8. `History: reply to command v1` (依賴 Lookup)
9. `History: register daily v1` (依賴 Deliver One)

#### 第三層：主入口與頂層排程流程 (Ingress & Triggers)
依賴前兩層完整功能，具備外部觸發器或排程器：
1. `AI SUMMARY v3` (呼叫 Coordinator)
2. `Req STT process v3` (呼叫 Dispatcher)
3. `IST bot entry v3` (呼叫各查詢與歷史子流程)
4. `IST bot Slack ingress v3` (入口轉發至 IST bot entry)
5. `Collect suspect streamID v3` (排程收集)
6. `History: ingest v1` (排程 Ingestion)
7. `Automation: retry and repair v3` (每分鐘核心修復排程)

### 4.3 舊主機防雙重觸發措施 (Split-Brain Prevention)
舊主機目前仍處於活躍狀態。為防止新舊兩台機器對同一個外部服務重複發動副作用（例如重複對 Slack 發通知、重複在 BigQuery 執行相同運算、重複寫入外部 DB），在**新主機啟動前**必須採取以下措施：
1. 在舊主機上將下列主動排程與監聽流程設為 **Inactive (停用)**：
   - `Automation: retry and repair v3`
   - `History: ingest v1`
   - `Collect suspect streamID v3`
   - `IST bot Slack ingress v3`
2. 確保舊主機停止產生新的背景任務後，再於新主機進行最終驗收。

---

## 五、 實體遷移執行 SOP (Step-by-Step)

### 步驟 1：環境設定檔準備
1. 將現行 `.env` 保留備份（指向舊主機 `34.144.237.1`）。
2. 將 `.env_new` 重新命名或更新為目標 `.env`，設定值包含：
   - `REMOTE_N8N_API_URL=https://n8n-ist.17app.co`
   - `REMOTE_N8N_API_KEY=<新機期的有效API金鑰>`
   - `STT_CALLBACK_URL=https://n8n-ist.17app.co/webhook/stt-callback-v3`

### 步驟 2：新機器憑證建立 (手動 UI 操作)
登入新主機 Web UI（`https://n8n-ist.17app.co` -> Settings -> Credentials），建立 5 組同名憑證：
- `n8n-streaming-testing` (`slackApi`)
- `Google BigQuery account` (`googleApi`)
- `Header Auth account 2` (`httpHeaderAuth`)
- `Vertex SA` (`googleApi`)
- `Google Gemini(PaLM) Api account` (`googlePalmApi`)

### 步驟 3：資料表結構建立與歷史資料列遷移 (Data Tables Provisioning & Rows Import)
1. **導出舊機資料**：執行 `node migration/migrate-data-tables.js --export migration/data-tables-backup`，自舊機完整導出 11 個 Table 的 Schema 與 22,057 筆資料。
2. **匯入新機資料**：執行 `node migration/migrate-data-tables.js --import migration/data-tables-backup`，在新主機自動建立缺失的 11 個資料表並批次寫入所有歷史資料列。
3. **一致性驗證**：執行 `node migration/migrate-data-tables.js --verify`，確認新機 11 個資料表的筆數與欄位完全吻合。

### 步驟 4：工作流程分層部署 (Workflows Deployment)
在 Data Tables 與 Credentials 均就緒後，執行 `scripts/deploy.js` 依相依性依序發布：
1. 部署第一層子流程：`node scripts/deploy.js workflows/<layer1_folders>...`
2. 部署第二層協調流程：`node scripts/deploy.js workflows/<layer2_folders>...`
3. 部署第三層頂層流程：`node scripts/deploy.js workflows/<layer3_folders>...`

### 步驟 5：舊主機停用與新主機啟用 (Deactivation & Activation)
1. 登入舊主機 Web UI，將主動排程（Schedule Trigger）工作流程設為 Inactive，避免新舊雙機同時對外部服務發動副作用。
2. 在新主機確認各工作流程之啟用狀態（Active），並檢查連線物件。

---

## 六、 轉移執行成果與驗收清單 (Execution Status & Validation Checklist)

### 6.1 已完成轉移項目 (100% 驗證通過)

1. **資料表遷移 (Data Tables)**：**【已完成 - 100% MATCH】**
   - 舊主機 11 個 Data Tables 結構已於新主機完整建立。
   - 22,057 筆資料列已全數匯入並通過雙端筆數比對驗證（11/11 表格完全一致）。
2. **工作流程遷移 (Workflows)**：**【已完成 - 100% PASS】**
   - 排除 4 個已歸檔歷史流程後，全部 44 個未歸檔工作流程已全數部署至新主機。
   - 所有工作流程的節點數量、結構、JS 程式碼皆 100% 吻合。
   - 所有 Data Table 節點已自動綁定至新主機的全新 Table ID。
   - 所有子流程呼叫（`Execute Workflow`）已自動重映射至新主機的工作流程 ID。
   - 核心錯誤處理器 `Automation: error handler v3` 已發布並啟用，其餘 43 個工作流程初始狀態為安全的 `Inactive`。
3. **標籤同步 (Tags)**：**【已完成 - 100% SYNC】**
   - 7 個標籤（`stt`, `ist-bot`, `aliveCheck`, `experiment`, `willy`, `v2`, `ist-bot-v3`）已建立。
   - 36 個關聯工作流程的標籤綁定已同步完畢。
4. **佔位憑證建立與節點綁定 (Placeholder Credentials)**：**【已完成 - 100% BOUND】**
   - 透過 `migration/provision-placeholder-credentials.js` 已在新主機建立 7 組同名、同 ID 的佔位憑證：
     1. `Google BigQuery account` (ID: `Dd7x1TQhh9YKbD8v`, type: `googleApi`)
     2. `Vertex SA` (ID: `xCxzQVNUYMaL9Cea`, type: `googleApi`)
     3. `Header Auth account 2` (ID: `b39tXWu6AGQsbY2C`, type: `httpHeaderAuth`)
     4. `n8n-streaming-testing` (ID: `9sfslX7caXSFAVUN`, type: `slackApi`)
     5. `Google Gemini(PaLM) Api account` (ID: `gMeMxD0Uq89xl8xy`, type: `googlePalmApi`)
     6. `GDrive token` (ID: `nSAb8g6cRvipp2vr`, type: `httpCustomAuth`)
     7. `STT callback auth` (ID: `8e699QSw7z2OEzw0`, type: `httpBasicAuth`)
   - 新主機上所有工作流程節點已全自動綁定成功，日常部署與校驗腳本（`scripts/deploy.js --dry-run`）已 100% 驗證通過。

---

### 6.2 下一步待處理清單 (Next Steps - Real Credentials & Activation)

- [ ] **【集中更新真實金鑰】**：當取得真實金鑰後，登入新主機 Web UI (`https://n8n-ist.17app.co` -> `Settings` -> `Credentials`)，點開憑證直接貼上真實內容並儲存（全站工作流程節點將全自動生效）：
  1. `Google BigQuery account`：貼上 GCP `media17-1119` 之 SA 金鑰內容。
  2. `Vertex SA`：貼上 GCP `aiops-338206` 之 SA 金鑰內容。
  3. `Header Auth account 2`：填入真實 STT API Header Token。
  4. `n8n-streaming-testing`：貼上真實 Slack Bot Token (`xoxb-...`)。
  5. `Google Gemini(PaLM) Api account`：填入真實 Gemini API Key (`AIza...`)。
- [ ] **【單步連線測試】**：於新主機隨機開啟各類別節點（BigQuery, Vertex, Slack, STT）點擊 Test step 驗證連線成功。
- [x] **【防雙重觸發】舊主機排程停用**：**【已完成】**
  - `Automation: retry and repair v3`（每分鐘排程）已停用。
  - `History: ingest v1`（每 5 分鐘排程）已停用。
  - `Collect suspect streamID v3`（每日 10:00 排程）已停用。
- [ ] **【防雙重觸發】舊主機 Slack Ingress 停用**：在舊主機停用 `IST bot Slack ingress v3`。
- [ ] **【單步連線測試】**：於新主機隨機開啟各類別節點（BigQuery, Vertex, Slack, STT）點擊 Test step 驗證連線成功。
- [ ] **【上線啟用】新主機工作流程啟用**：依分層順序將新主機工作流程切換為 `Active`。
