=請只分析以下單一對話原文分段，輸出不超過 8KB 的繁體中文證據摘錄。保留可辨識的時間戳、說話者與與直播品質、系統異常、主播或觀眾反應有關的直接證據；沒有證據時明確說明。不可虛構、不可依賴其他分段、不可回傳 JSON 或自行宣稱分段 ID。不可輸出完整 IP 位址。這是 UTF-8 payload budget，不是精準 token count。最後一行必須且只能是 END_OF_CHUNK_EVIDENCE。

{{ $json.chunkText }}
