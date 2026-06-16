// 處理每一筆輸入的資料
return items.map(item => {
  const oldBody = item.json.body || {};
  const oldWebhook = oldBody.webhook || {};
  const oldContext = oldWebhook.context || [];

  // 1. 處理 Context：從 [{Key: "xxx", Value: "yyy"}] 轉回 { "xxx": "yyy" }
  let newContext = {};
  if (Array.isArray(oldContext)) {
    oldContext.forEach(pair => {
      // 確保 Key 存在且不為 null
      if (pair && pair.Key) {
        newContext[pair.Key] = pair.Value;
      }
    });
  } else {
    newContext = oldContext;
  }

  const newBody = {
    statusCode: oldBody.statusCode || 200,
    languages: oldBody.languages, 
    transcription: oldBody.transcription || "",
    webhook: {
      context: newContext
    }
  };

  return {
    json: {
      headers: item.json.headers,
      params: item.json.params,
      query: item.json.query,
      body: newBody,
    }
  };
});