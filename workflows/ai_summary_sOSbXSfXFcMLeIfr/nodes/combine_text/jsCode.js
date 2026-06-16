// 將模式設置為 Run Once for All Items
return [
  {
    json: {
      jsonString: JSON.stringify($input.all().map(item => item.json), null, 2)
    }
  }
];