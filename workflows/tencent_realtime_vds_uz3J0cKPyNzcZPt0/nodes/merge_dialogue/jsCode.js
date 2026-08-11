
// ====================================================================
// 1. 設定配置項
// ====================================================================
// 請在此設定您的直播錄影開始時間（台北時間 UTC+8），用來與 STT 的相對毫秒做對齊
const unixTimestamp = Number($('steamID beginTime and endTime1').first().json.publishSec) * 1000;

const formatter = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false // 使用 24 小時制
});

const formattedDate = formatter.format(new Date(unixTimestamp)).replace(/\//g, '-');
const RECORDING_START_STR = formattedDate;

// ====================================================================
// 2. 輔助函式
// ====================================================================
function normalizeSpaces(text) {
    if (!text) return "";
    return text.trim().replace(/\s+/g, ' ');
}

function parseTaipeiDateTimeToTimestamp(rawStr) {
    if (!rawStr) return 0;
    let cleanStr = rawStr.trim();
    // 補足時區與相容 JavaScript 毫秒限制
    if (!cleanStr.includes('Z') && !cleanStr.includes('+') && !cleanStr.includes('-')) {
        cleanStr = cleanStr.replace(/(\.\d{3})\d+/, '$1'); // 截斷微秒
        cleanStr += "+08:00"; // 強制指定台北時區
    }
    const parsedDate = new Date(cleanStr);
    if (isNaN(parsedDate.getTime())) {
        return 0;
    }
    return parsedDate.getTime() / 1000; // 轉換為秒數戳記
}

// ====================================================================
// 3. 主要邏輯
// ====================================================================
const timelineEvents = [];
const recordingStartTs = parseTaipeiDateTimeToTimestamp(RECORDING_START_STR);

// n8n 的輸入資料存放在 $input.all() 之中
const inputItems = $input.all();

let sttList = [];
let commentsList = [];

// 拆解輸入的 JSON 結構
inputItems.forEach(item => {
    const data = item.json;
    if (data.stt && Array.isArray(data.stt)) {
        sttList = data.stt;
    }
    if (data.comments && Array.isArray(data.comments)) {
        commentsList = data.comments;
    }
});

// 處理實況主語音 (STT)
sttList.forEach(stt => {
    const content = normalizeSpaces(stt.content);
    if (!content || stt.startMs === undefined) return;

    const startSec = stt.startMs / 1000;
    const startedAt = recordingStartTs + startSec;

    timelineEvents.push({
        type: "streamer",
        startedAt: startedAt,
        content: content,
        speaker: ""
    });
});

// 處理觀眾留言 (Comments)
commentsList.forEach(comment => {
    const content = normalizeSpaces(comment.s_content);
    if (!content) return;

    const startedAt = parseTaipeiDateTimeToTimestamp(comment.UTCp8);
    if (startedAt === 0) return;

    let speaker = normalizeSpaces(comment.s_reqOpenID);
    if (!speaker) {
        speaker = normalizeSpaces(comment.s_reqUserID);
    }

    timelineEvents.push({
        type: "viewer",
        startedAt: startedAt,
        content: content,
        speaker: speaker
    });
});

// 依據時間軸(startedAt)由小到大排序
timelineEvents.sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.content.localeCompare(b.content);
});

// ====================================================================
// 4. 符合 n8n 規範的輸出格式化
// ====================================================================
// n8n 需要回傳 [{ json: { ... } }] 的結構
// 這裡將排序好的事件，一筆一筆包裝成 n8n 的 Item，方便後續節點（如：LINE, Google Sheets, HTTP Request）一個個處理
return timelineEvents.map(event => {
    return {
        json: event
    };
});