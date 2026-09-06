function collectKnownIPs(value, key = '', output = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectKnownIPs(item, '', output));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([name, item]) => collectKnownIPs(item, name, output));
  else if (typeof value === 'string' && ['publicip', 'userip'].includes(key.toLowerCase()) && value !== '') output.add(value);
  return output;
}
function redactKnownIPs(value, knownIPs) {
  if (typeof value === 'string') return knownIPs.reduce((text, ip) => text.split(ip).join('[REDACTED_IP]'), value);
  if (Array.isArray(value)) return value.map((item) => redactKnownIPs(item, knownIPs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactKnownIPs(item, knownIPs)]));
  return value;
}
function normalizeInference(raw) {
  const carrier = raw.carrier || raw;
  const candidate = raw.output || raw.response || raw.data || raw;
  const inference = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
  if (!inference || Array.isArray(inference) || typeof inference !== 'object' || !inference.report || typeof inference.report !== 'object') throw new Error('invalid inference report');
  const knownIPs = [...collectKnownIPs(carrier.aggregate)].sort((left, right) => right.length - left.length);
  const redacted = redactKnownIPs(inference, knownIPs);
  return { ...carrier, inference: redacted, inferenceResultJson: JSON.stringify(redacted) };
}
if (typeof module !== 'undefined') module.exports = { collectKnownIPs, normalizeInference, redactKnownIPs };
if (typeof $input !== 'undefined') return [{ json: normalizeInference($input.first().json) }];
