function buildFailureStatus(row) {
  if (!row || !/^\d{10,}\.\d{6}$/.test(row.summaryMessageTS || '')) throw new Error('summary_status_message_missing');
  if (!['failed', 'summary_retry_pending'].includes(row.status)) throw new Error('summary_failure_status_invalid');
  const reason = row.errorCode === 'summary_model_empty_response'
    ? 'The AI model returned no usable response. '
    : row.errorCode === 'summary_model_output_invalid' ? 'The AI model returned an invalid report. '
      : ['summary_analysis_scope_invalid', 'summary_analysis_scope_mismatch'].includes(row.errorCode)
        ? 'Analysis scope validation failed. No report was published for this attempt. ' : '';
  return {
    ...row,
    statusText: row.status === 'failed'
      ? `${reason}AI summary failed after the retry limit. Please review the workflow execution.`
      : `${reason}AI summary will retry shortly.`,
  };
}
if (typeof module !== 'undefined') module.exports = { buildFailureStatus };
if (typeof $input !== 'undefined') return [{ json: buildFailureStatus($input.first().json) }];
