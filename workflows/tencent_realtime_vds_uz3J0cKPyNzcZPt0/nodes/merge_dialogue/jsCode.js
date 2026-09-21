// ====================================================================
// 1. 設定配置項
// ====================================================================

// publishSec 是 Unix timestamp（秒），不要再轉換成台北時間
const recordingStartTs = Number(
  $('steamID beginTime and endTime1').first().json.publishSec
);

// ====================================================================
// 2. 輔助函式
// ====================================================================

function normalizeSpaces(text) {
  if (!text) return "";
  return text.trim().replace(/\s+/g, " ");
}

function parseTaipeiDateTimeToTimestamp(rawStr) {
  if (!rawStr) return 0;

  let cleanStr = String(rawStr).trim();

  // 沒有時區資訊時，指定為台北時間
  if (
    !cleanStr.includes("Z") &&
    !cleanStr.includes("+") &&
    !cleanStr.match(/-\d{2}:\d{2}$/)
  ) {
    cleanStr = cleanStr.replace(/(\.\d{3})\d+/, "$1");
    cleanStr += "+08:00";
  }

  const parsedDate = new Date(cleanStr);

  if (isNaN(parsedDate.getTime())) {
    return 0;
  }

  return parsedDate.getTime() / 1000;
}

// ====================================================================
// 3. 讀取輸入資料
// ====================================================================

const timelineEvents = [];
const inputItems = $input.all();

let sttList = [];
let commentsList = [];

inputItems.forEach((item) => {
  const data = item.json;

  if (data.stt && Array.isArray(data.stt)) {
    sttList = data.stt;
  }

  if (data.comments && Array.isArray(data.comments)) {
    commentsList = data.comments;
  }
});

// ====================================================================
// 4. 處理實況主語音
// ====================================================================

sttList.forEach((stt) => {
  const content = normalizeSpaces(stt.content);

  if (!content || stt.startMs === undefined) {
    return;
  }

  // STT startMs 是相對於錄音開始時間的毫秒
  const startSec = Number(stt.startMs) / 1000;
  const startedAt = recordingStartTs + startSec;

  timelineEvents.push({
    type: "streamer",
    startedAt,
    content,
    speaker: ""
  });
});

// ====================================================================
// 5. 處理觀眾留言
// ====================================================================

commentsList.forEach((comment) => {
  const content = normalizeSpaces(comment.s_content);

  if (!content) {
    return;
  }

  const startedAt = parseTaipeiDateTimeToTimestamp(comment.UTCp8);

  if (startedAt === 0) {
    return;
  }

  let speaker = normalizeSpaces(comment.s_reqOpenID);

  if (!speaker) {
    speaker = normalizeSpaces(comment.s_reqUserID);
  }

  timelineEvents.push({
    type: "viewer",
    startedAt,
    content,
    speaker
  });
});

// ====================================================================
// 6. 依時間排序
// ====================================================================

timelineEvents.sort((a, b) => {
  if (a.startedAt !== b.startedAt) {
    return a.startedAt - b.startedAt;
  }

  if (a.type !== b.type) {
    return a.type.localeCompare(b.type);
  }

  return a.content.localeCompare(b.content);
});

// ====================================================================
// 7. n8n 輸出格式
// ====================================================================

return timelineEvents.map((event) => ({
  json: event
}));