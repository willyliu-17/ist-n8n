=📢 *Stream Log Summary* 📢
- StreamID: `{{ $('steamID beginTime and endTime1').first().json.liveStreamID }}`
- CloseBy: `{{ $('steamID beginTime and endTime1').first().json.closeBy }}`
- duration: `{{ $('steamID beginTime and endTime1').first().json.duration }}`
- deviceInfo: `{{ $('steamID beginTime and endTime1').first().json.type }}`, `{{ $('steamID beginTime and endTime1').first().json.deviceModel }}`
{{ $json.slackMessage }}