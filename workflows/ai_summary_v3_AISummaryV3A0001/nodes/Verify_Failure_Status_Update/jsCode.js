function verifyFailureStatusUpdate(response, row) {
  const timestamp = response?.message_timestamp || response?.message?.ts || response?.ts;
  if (!response || response.error || response.ok !== true || response.channel !== row.channel
    || timestamp !== row.summaryMessageTS) throw new Error('summary_failure_status_update_failed');
  return row;
}
if (typeof module !== 'undefined') module.exports = { verifyFailureStatusUpdate };
if (typeof $input !== 'undefined') {
  return [{ json: verifyFailureStatusUpdate($input.first().json, $('Build Failure Status').first().json) }];
}
