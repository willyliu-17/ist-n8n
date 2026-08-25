=StreamID: {{ $('steamID beginTime and endTime1').first().json.liveStreamID }}
Logs:
{{
 (()=>{
  const logExists = $json.streamerLog?.permalink || $json.streamerEventLog?.permalink || $json.streamCommentLog?.permalink;
  if (!logExists) {
    return 'No logs available for this stream.';
  }

  let logList = [];

  // StreamerLog
  if ($json.streamerLog?.permalink) {
    logList.push(`- <${$json.streamerLog.permalink}|StreamerLog>`);
  } else {
    logList.push(`- No StreamerLog available for this stream.`);
  }

  // StreamerEventLog
  if ($json.streamerEventLog?.permalink) {
    logList.push(`- <${$json.streamerEventLog.permalink}|StreamerEventLog>`);
  } else {
    logList.push(`- No StreamerEventLog available for this stream.`);
  }

  // StreamCommentLog
  if ($json.streamCommentLog?.permalink) {
    logList.push(`- <${$json.streamCommentLog.permalink}|StreamCommentLog>`);
  } else {
    logList.push(`- No StreamCommentLog available for this stream.`);
  }

  // MatomoLog
  if ($json.matomoLog?.permalink) {
    logList.push(`- <${$json.matomoLog.permalink}|MatomoLog>`);
  } else {
    logList.push(`- No MatomoLog available for this stream.`);
  }

  // 使用換行符連接列表項目
  return logList.join('\n');
})()
}}