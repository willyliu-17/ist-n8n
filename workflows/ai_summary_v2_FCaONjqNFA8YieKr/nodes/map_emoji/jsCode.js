// 1. 抓取資料
const categoryList = $('Normalize AI Output').first().json.summary.report.summary.responsibility_category_list;
const deviceModel = $('Aggregate').first().json.data[0].details[3].deviceModel
const deviceType =$('Aggregate').first().json.data[0].details[3].type
// 2. 定義對照表
const emojiMap = {
  "0": "zero",
  "1": "one",
  "2": "two",
  "0-b": "low_battery",
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
  const mainId = rawId.split('-')[0];

  // A. 大類 (例如 "0")
  if (emojiMap[mainId]) {
    results.push(emojiMap[mainId]);
  }
  
  // B. 細項 (例如 "0-b")
  if (rawId.includes('-') && emojiMap[rawId]) {
    results.push(emojiMap[rawId]);
  }
});

// 5. 去除重複並格式化輸出
return [...new Set(results)].map(emojiName => ({
  json: { emoji: emojiName }
}));