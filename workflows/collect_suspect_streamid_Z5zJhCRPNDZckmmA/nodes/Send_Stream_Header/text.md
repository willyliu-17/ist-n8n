==🔍 *自動化檢測詳情* | userID `{{ $json.userID }}`
StreamID: `{{ $json.streamID }}`
Source: {{ $json.sources.join(', ') }}
{{
  (($json.sources.join(',').includes('commentCaptionKeyword') || $json.sources.join(',').includes('captionKeyword'))
    ? '\n🎯 Hit Keywords: `' + $('Set Config').first().json.searchKeywords + '`' 
    : ''
  ) 
  + 
  (($json.sources.join(',').includes('endByNewStream'))
    ? '\n⏳ Hit Conditions: `Prev endByNewStream + Restart in 60s + Contracted TW streamer`'
    : ''
  )
  +
  ($json.prevStreamID 
    ? '\n PrevStreamID: `' + $json.prevStreamID + '`' 
    : ''
  )
}}