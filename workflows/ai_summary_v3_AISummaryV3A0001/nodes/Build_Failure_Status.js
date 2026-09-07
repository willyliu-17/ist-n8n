const row = $input.first().json;
if (!row.summaryMessageTS) return [];
const reason = row.errorCode === 'summary_model_empty_response'
  ? 'The AI model returned no usable response. '
  : row.errorCode === 'summary_model_output_invalid' ? 'The AI model returned an invalid report. ' : '';
return [{ json: {
  ...row,
  statusText: row.status === 'failed'
    ? `${reason}AI summary failed after the retry limit. Please review the workflow execution.`
    : `${reason}AI summary will retry shortly.`,
} }];
