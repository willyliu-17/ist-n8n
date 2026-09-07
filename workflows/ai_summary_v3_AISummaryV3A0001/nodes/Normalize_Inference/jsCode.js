function collectKnownIPs(value, key = '', output = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectKnownIPs(item, '', output));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([name, item]) => collectKnownIPs(item, name, output));
  else if (typeof value === 'string' && ['publicip', 'userip'].includes(key.toLowerCase()) && value !== '') output.add(value);
  return output;
}
function collectTextIPs(value, output = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectTextIPs(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectTextIPs(item, output));
  else if (typeof value === 'string') {
    for (const match of value.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      if (match[0].split('.').every((part) => Number(part) <= 255)) output.add(match[0]);
    }
    for (const match of value.matchAll(/[\da-f]*:[\da-f:.]+/gi)) {
      const candidate = match[0].replace(/\.+$/, '');
      let ipv6 = candidate;
      if (ipv6.includes('.')) {
        const lastColon = ipv6.lastIndexOf(':');
        const ipv4 = ipv6.slice(lastColon + 1);
        if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ipv4) || ipv4.split('.').some((part) => Number(part) > 255)) continue;
        ipv6 = `${ipv6.slice(0, lastColon + 1)}0:0`;
      }
      const halves = ipv6.split('::');
      if (halves.length > 2) continue;
      const groups = halves.flatMap((part) => part === '' ? [] : part.split(':'));
      const validCount = halves.length === 2 ? groups.length < 8 : groups.length === 8;
      if (validCount && groups.every((part) => /^[\da-f]{1,4}$/i.test(part))) output.add(candidate);
    }
  }
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
  const addresses = collectKnownIPs(carrier.aggregate);
  if (carrier.input?.requestType === 'single_stream_summary') {
    collectTextIPs(carrier.aggregate, addresses);
    collectTextIPs(inference, addresses);
  }
  const knownIPs = [...addresses].sort((left, right) => right.length - left.length);
  const redacted = redactKnownIPs(inference, knownIPs);
  return { ...carrier, inference: redacted, inferenceResultJson: JSON.stringify(redacted) };
}
if (typeof module !== 'undefined') module.exports = { collectKnownIPs, collectTextIPs, normalizeInference, redactKnownIPs };
if (typeof $input !== 'undefined') return [{ json: normalizeInference($input.first().json) }];
