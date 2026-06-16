// 1. 取得所有輸入的項目 (例如你提到的 6 個 items)
const allItems = $input.all();

// 2. 過濾無效項目並進行群組化
const grouped = allItems.reduce((acc, item) => {
  const data = item.json;
  
  // 過濾掉沒有 liveStreamID 或內容為空的項目
  if (data && data.liveStreamID && Object.keys(data).length > 0) {
    const sID = data.liveStreamID;

    // 如果這個 liveStreamID 還沒在累加器中，建立一個新的群組
    if (!acc[sID]) {
      acc[sID] = {
        liveStreamID: sID,
        // 你可以根據需求決定要保留哪些原始資料
        // 這裡將同一 liveStreamID 的所有內容放入一個名為 logs 的陣列中
        details: [], 
        count: 0
      };
    }

    // 將當前 item 的資料塞入該群組的陣列中
    acc[sID].details.push(data);
    acc[sID].count++;
  }
  
  return acc;
}, {});

// 3. 將物件轉回 n8n 預期的陣列格式 (每個 unique liveStreamID 會變成一個新的 Item)
return Object.values(grouped);