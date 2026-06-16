// 將聚合的詳細清單拆解回獨立的 Items，供 Loop 使用
const detailedList = $('Code dedup').first().json.detailedList

return detailedList.map(item => {
  return { json: item };
});