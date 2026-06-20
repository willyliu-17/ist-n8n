=Stream: `{{ $node["Webhook"].json.body.webhook.context.streamid_input }}`
{{
  $node["Webhook"].json.body.statusCode != 200 
  ? "⚠️ Status Code: " + $node["Webhook"].json.body.statusCode + ($node["Webhook"].json.body.error ? "\n❌ Error: " + $node["Webhook"].json.body.error : "")
  : "No transcription data" 
}}