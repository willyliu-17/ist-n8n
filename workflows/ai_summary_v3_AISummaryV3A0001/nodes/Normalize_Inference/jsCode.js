const raw = $input.first().json;
const carrier = raw.carrier || raw;
const candidate = raw.output || raw.response || raw.data || raw;
const inference = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
if (!inference || Array.isArray(inference) || typeof inference !== 'object' || !inference.report || typeof inference.report !== 'object') throw new Error('invalid inference report');
return [{ json: { ...carrier, inference, inferenceResultJson: JSON.stringify(inference) } }];
