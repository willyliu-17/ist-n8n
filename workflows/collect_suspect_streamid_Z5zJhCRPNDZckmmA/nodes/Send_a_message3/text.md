={{
  (() => {
    try {
      if ($('Manually trigger').first().json) {
        return '🛠️ *手動觸發檢測報告*' + $('Manually trigger').first().json.timestamp;
      }
    } catch (error) {}
    return '🕊️ *自動化異常 Stream 監控報告*';
  })()
}}

**天下太平**，目前未發現任何異常。
偵測數：0
監控時間：{{ $now.toFormat('yyyy-MM-dd HH:mm:ss') }}