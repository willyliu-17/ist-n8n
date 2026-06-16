// 假設輸入來自前一個 Slack 節點的 Get Replies 動作
const items = Array.isArray($input.all()) ? $input.all() : [$input.all()];
let results = [];

for (const item of items) {
  // Slack 的回傳格式通常在 json 欄位內
  const msg = item.json;

  // 過濾掉已經被刪除的訊息 (tombstone)
  // 如果你想連已被刪除的佔位符也一併嘗試刪除，可以拿掉這個判斷
  if (msg.subtype === 'tombstone') {
    continue;
  }

  // 整理出我們需要的資訊
  results.push({
    ts: msg.ts,
    text: msg.text ? msg.text.substring(0, 20) + '...' : 'No text', // 僅供辨識用
    is_parent: msg.ts === msg.thread_ts
  });
}

// 為了讓後續節點可以「一個一個」處理，我們回傳一個物件陣列
return results.map(r => ({ json: r }));