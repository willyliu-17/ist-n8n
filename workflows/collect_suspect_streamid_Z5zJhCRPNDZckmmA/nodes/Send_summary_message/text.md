={{
(() => {
    try {
      if ($('Manually trigger').first().json) {
        return '🛠️ *手動觸發檢測報告*\n' + $('Manually trigger').first().json.timestamp + ' Inverval: '+ $('Manually trigger').first().json.manualInterval + 'day';
      }
    } catch (error) {
      // Ignore error
    }
    // Auto
    return '🚨 *自動化異常 Stream 監控報告*';
  })()
}}
監控關鍵字: `{{ $('Set Config').first().json.searchKeywords }}`
以及監控 endByNewStream Conditions: `Prev endByNewStream + Restart in 60s + Contracted TW streamer`
共發現 {{ $json.totalCount }} 個可疑 Stream。

詳細清單：
{{ $json.detailedList
  .map(item =>
    '• StreamID: ' + item.streamID +
    (item.prevStreamID ? ' (PrevStreamID: ' + item.prevStreamID + ')' : '') +
    ' (來源: ' + item.sources.join(', ') + ')'
  )
  .join('\n')
}}