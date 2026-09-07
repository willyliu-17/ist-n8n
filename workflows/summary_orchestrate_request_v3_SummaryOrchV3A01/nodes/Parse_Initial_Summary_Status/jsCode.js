const SLACK_TS = /^\d{10,}\.\d{6}$/;

function parseInitialSummaryStatus(plan, response, checkpointUpdatedAtIso = new Date().toISOString()) {
  if (!plan || !response || response.ok !== true) throw new Error('Slack initial summary status was not accepted');
  const message = response.message;
  const ts = message?.ts;
  if (response.channel !== plan.channel || message?.thread_ts !== plan.threadTS
    || typeof ts !== 'string' || !SLACK_TS.test(ts) || response.message_timestamp !== ts
    || typeof checkpointUpdatedAtIso !== 'string' || !Number.isFinite(Date.parse(checkpointUpdatedAtIso))) {
    throw new Error('Slack initial summary status routing or timestamp is invalid');
  }
  return { ...plan, summaryMessageTS: ts, checkpointUpdatedAtIso };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { parseInitialSummaryStatus };

if (typeof $input !== 'undefined') {
  const merged = $input.first().json;
  return [{ json: parseInitialSummaryStatus($('Plan Initial Summary Status').first().json, merged) }];
}
