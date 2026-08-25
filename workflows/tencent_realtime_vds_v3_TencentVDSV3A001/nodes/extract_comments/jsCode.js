// 確保將模式設定為 "Run once for all items"
const allItems = $input.all().map(item => item.json);

return [
  {
    json: {
      comments: allItems
    }
  }
];