// 1. 直接從上一個 Edit Fields 節點安全地抓取純文字資料
const rawText = $input.first().json.text || ""; 

// 2. 切開每一行並過濾空行
const lines = rawText.split(/\r?\n/).filter(line => line.trim() !== '');
const formattedArray = [];
let baseTimeMs = null;

// 3. 逐行解析與轉換格式
for (const line of lines) {
    const cleanLine = line.trim();
    if (!cleanLine) continue;

    try {
        const item = JSON.parse(cleanLine);
        if (!item || !item.startedAt) continue;

        let currentMs = Number(item.startedAt);
        if (currentMs < 50000000000) {
            currentMs = currentMs * 1000;
        }

        if (baseTimeMs === null && !isNaN(currentMs)) {
            baseTimeMs = currentMs;
        }

        let videoOffset = "[00:00:00]";
        if (baseTimeMs !== null && !isNaN(currentMs)) {
            const diffSeconds = Math.max(0, Math.floor((currentMs - baseTimeMs) / 1000));
            const hours = String(Math.floor(diffSeconds / 3600)).padStart(2, '0');
            const minutes = String(Math.floor((diffSeconds % 3600) / 60)).padStart(2, '0');
            const seconds = String(diffSeconds % 60).padStart(2, '0');
            videoOffset = `[${hours}:${minutes}:${seconds}]`;
        }
        
        formattedArray.push({
            json: {
                username: item.speaker || "",
                message: item.content || "",
                timestamp: item.startedAt,
                videoOffset: videoOffset,
                eventType: item.type || ""
            }
        });
    } catch (error) {
        continue;
    }
}

return formattedArray;