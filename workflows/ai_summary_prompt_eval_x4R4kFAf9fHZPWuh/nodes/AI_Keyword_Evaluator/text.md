=請比對下列摘要與關鍵字是否語意命中。

expected_keywords: {{ JSON.stringify($json.expected_keywords || []) }}
causal_summary: {{ JSON.stringify(($json.summary && $json.summary.report && $json.summary.report.summary && $json.summary.report.summary.causal_summary) ? $json.summary.report.summary.causal_summary : '') }}