function createApi({ apiUrl, apiKey, fetchImpl = globalThis.fetch }) {
    if (!apiUrl || !apiKey) throw new Error('n8n API URL and key are required');
    const base = apiUrl.replace(/\/$/, '');
    async function request(endpoint, { method = 'GET', body } = {}) {
        const response = await fetchImpl(`${base}/api/v1/${endpoint}`, {
            method,
            redirect: 'error',
            signal: AbortSignal.timeout(30000),
            headers: { 'X-N8N-API-KEY': apiKey, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
        // Error bodies can contain credentials or user payloads. Never log them.
        if (!response.ok) throw new Error(`n8n ${method} ${endpoint.split('?')[0]}: HTTP ${response.status}`);
        try { return await response.json(); }
        catch { throw new Error(`Invalid JSON response for ${method} ${endpoint.split('?')[0]}`); }
    }
    async function list(resource) {
        const items = [];
        const seen = new Set();
        let cursor;
        do {
            const query = new URLSearchParams({ limit: '100' });
            if (cursor) query.set('cursor', cursor);
            const page = await request(`${resource}?${query}`);
            if (!page || !Array.isArray(page.data)) throw new Error(`Invalid ${resource} page`);
            items.push(...page.data);
            cursor = page.nextCursor;
            if (cursor && (typeof cursor !== 'string' || seen.has(cursor))) throw new Error(`Invalid or repeated ${resource} cursor`);
            if (cursor) seen.add(cursor);
        } while (cursor);
        return items;
    }
    return { request, list };
}

module.exports = { createApi };
