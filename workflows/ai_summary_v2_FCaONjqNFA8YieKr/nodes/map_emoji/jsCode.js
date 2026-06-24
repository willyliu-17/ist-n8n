// 1. 抓取資料
const categoryList = $('Normalize AI Output').first().json.summary.report.summary.responsibility_category_list;

const aggregateData = $('Aggregate').first().json.aggregateData || [];
let deviceModel = '';
let deviceType = '';

if (aggregateData.length > 0 && aggregateData[0].details) {
  const streamInfoDetail = aggregateData[0].details.find(d => d.type === 'streamInfo');
  if (streamInfoDetail && streamInfoDetail.streamInfo && streamInfoDetail.streamInfo[0]) {
    deviceModel = streamInfoDetail.streamInfo[0].deviceModel || '';
    deviceType = streamInfoDetail.streamInfo[0].type || '';
  }
}
// 2. 定義對照表
const emojiMap = {
  "1-a": "thermometer",
  "1-b": "movie_camera",
  "1-c": "memory",
  "1-d": "boom",
  "1-e": "cop",
  "1-f": "internet-problems",
  "1-g": "user",
  "2-a": "low_battery",
  "2-b": "gift",
  "2-c": "signal_strength",
  "2-d": "no_entry",
  "2-e": "question",
};

const results = [];

// 3. 裝置類型邏輯
if (deviceType.toLowerCase() === 'android') {
  results.push('android_robot');
} else if (deviceType.toLowerCase() === 'ios') {
  const model = deviceModel.toLowerCase();
  if (model.includes('ipad')) {
    results.push('ipad'); 
  } else {
    results.push('device_iphone');
  }
}

// 4. 處理分類邏輯 (大類先出，小項緊跟其後)
categoryList.forEach(rawId => {
  const match = rawId.match(/\[(.*?)\]/);
  if (!match) return;
  const idStr = match[1];
  const mainId = idStr.split('-')[0];

  // A. 大類 (例如 "1")
  if (emojiMap[mainId]) {
    results.push(emojiMap[mainId]);
  }
  
  // B. 細項 (例如 "1-a")
  if (idStr.includes('-') && emojiMap[idStr]) {
    results.push(emojiMap[idStr]);
  }
});

// 5. 去除重複並格式化輸出
return [...new Set(results)].map(emojiName => ({
  json: { emoji: emojiName }
}));