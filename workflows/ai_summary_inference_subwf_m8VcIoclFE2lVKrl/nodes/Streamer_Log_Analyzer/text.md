={{ (() => {
  const request = $fromAI('Prompt__User_Message_', ``, 'string');
  const aggregate = $('Aggregate').first().json.data || [];
  const data = [];

  aggregate.forEach(item => {
    const details = Array.isArray(item.details) ? item.details : [];
    details.forEach(detail => {
      if (detail && detail.type === 'streamerLog') {
        data.push(detail);
      }
    });
  });

  const payload = { request, data };
  if (data.length === 0) {
    payload.notice = '無對應的 streamerLog 資料，請回報無資料。';
  }

  return JSON.stringify(payload, null, 2);
})() }}