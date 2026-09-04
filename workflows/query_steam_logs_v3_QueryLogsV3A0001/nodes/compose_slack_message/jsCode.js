  const summary = $json;
  
  if (!summary || !summary.conditions) {
    // 如果數據結構無效，返回一個錯誤訊息 Item
    return [{
        json: {
            slackMessage: "❌ 錯誤：無法取得有效的檢查摘要數據。"
        }
    }];
  }


  const totalChecked = summary.totalItemsChecked;
  const conditions = summary.conditions;
  let message = ``;

  for (const conditionId in conditions) {
    const cond = conditions[conditionId];
    const status = cond.status;
    const failedCount = cond.failedLines.length;

    message += `${status === 'Success' ? ':17baby-robot-green:' : ':17baby-robot-red:'} ${cond.description} \n`;

    if (status === 'Failed') {
      message += `      - failed count: ${failedCount} \n`;
      
      // cond.failedLines.forEach(line => {
      //   message += `    > ${line.timestamp}  : ${line.dataSnippet} \n`;
      // });
    }
  }

  return [{
      json: {
          slackMessage: message
      }
  }];