// 1. 取得前方所有轉換好的 JSON 項目
const items = $input.all();

// 2. 將每一個物件還原成 JSON 字串（維持既有的 JSONL 格式）
const jsonlLines = items.map(item => JSON.stringify(item.json));

// 3. 用換行符號將所有 JSON 字串串接在一起，變成單一文字
const encodedJsonlText = jsonlLines.join('\n');

// 3. 輸出符合你要求的格式結構
return [{
    json: {
        body: {
          openID:$('get openID').first().json.openID,
          userID:$('steamID beginTime and endTime1').first().json.userID,
          streamID:$('Normalize Input').first().json.streamID,
          region:$('steamID beginTime and endTime1').first().json.region,
            content: encodedJsonlText,
        }
    }
}];
