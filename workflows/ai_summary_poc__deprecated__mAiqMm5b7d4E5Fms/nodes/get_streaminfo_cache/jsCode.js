// 獲取整個 Array 的 JSON 數據
try {
    // .all() 會取得該節點產出的所有項目 (Array of Objects)
    const allItems = $("query stream info").all();
    
    // 使用 map 提取每個項目的 json 內容，並打包成一個 Array
    const dataArray = allItems.map(item => item.json);
    
    // 將整個 Array 轉化為字串，加上縮排
    return JSON.stringify(dataArray, null, 2); 
    
} catch (error) {
    return `錯誤：無法獲取 "Stream Info" 的完整數據。原因：${error.message}`;
}