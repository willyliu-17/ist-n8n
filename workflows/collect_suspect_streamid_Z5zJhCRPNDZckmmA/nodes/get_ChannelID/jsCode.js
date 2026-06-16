let isManual = false;

try {
  // 嘗試讀取 Manually trigger 的數據
  // 如果是排程觸發，這一行會報錯，直接跳到 catch
  if ($('Manually trigger').first().json) {
    isManual = true;
  }
} catch (error) {
  // 捕捉到錯誤，代表該節點未執行 (即為排程觸發)
  // 不做任何事，保持 isManual = false
}

if (isManual) {
  // 手動觸發的邏輯
  return [
    { "id": "C0A4JJJKJMD" }
  ];
} else {
  // 自動/排程觸發的邏輯
  return [
    { "id": "C09F0SYG57D" }
  ];
}