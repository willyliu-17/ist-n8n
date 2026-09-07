={{ (() => {
  const error = $json.error;
  const message = typeof error === 'string' ? error : error?.message || $json.message || '';
  if (/^Cannot read properties of undefined \(reading ['"]message['"]\)/.test(message)) {
    return 'summary_model_empty_response';
  }
  if (/Model output (?:does not|doesn't) fit required format|Failed to parse/i.test(message)) {
    return 'summary_model_output_invalid';
  }
  return 'summary_inference_failed';
})() }}
