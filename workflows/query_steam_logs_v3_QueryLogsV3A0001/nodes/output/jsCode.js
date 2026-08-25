// 獲取 Merge1 節點的所有資料
const items = $("Merge1").all();

// 建立一個新的物件來存放結果
let fileIDMap = {};

// 遍歷所有 Item，將其 id 提取並放入對應的 Key
items.forEach(item => {
  // 假設你的每個 Item 裡面都有一個唯一的 key (例如 streamerLog)
  // 這裡自動抓取 json 下的第一個 Key 名稱 (例如 "streamerLog")
  const keyName = Object.keys(item.json)[0]; 
  
  if (keyName && item.json[keyName].id) {
    fileIDMap[keyName] = item.json[keyName].id;
  }
});

// 回傳符合你要求的格式
return {
  fileID: fileIDMap
};