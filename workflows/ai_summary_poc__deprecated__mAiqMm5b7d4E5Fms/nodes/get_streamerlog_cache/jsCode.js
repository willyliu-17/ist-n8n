try {
    // 1. 獲取該節點緩存的所有原始數據 (Array of Objects)
    const rawData = $("StreamerLog").all().map(item => item.json);

    // 2. 檢查數據是否存在
    if (!rawData || rawData.length === 0) {
        return "⚠️ 數據緩存為空，請確認上游 BigQuery 或 CSV 節點是否有成功抓取資料。";
    }

    // 3. 原封不動回傳所有欄位與所有列
    // 讓 AI 拿到完整數據後，自行在 Thought 過程中進行時序對齊與動機回溯
    return JSON.stringify(rawData, null, 2);

} catch (error) {
    // 捕捉節點名稱錯誤或執行異常
    return `❌ 錯誤：無法獲取 "StreamerEventLog" 資料。請檢查節點名稱是否正確。原因：${error.message}`;
}