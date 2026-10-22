const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const MAX_BODY_BYTES = 512 * 1024;
const requestWindows = new Map();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function corsHeaders(origin, env) {
  const allowed = allowedOrigins(env);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function checkRateLimit(request) {
  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const current = requestWindows.get(ip);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    requestWindows.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= MAX_REQUESTS_PER_WINDOW;
}

function configuredModel(env) {
  return (env.GEMINI_MODEL || 'gemini-2.5-flash').trim().replace(/^models\//, '');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('Origin'), env);
    if (!cors) return json({ error: 'Origin is not allowed.' }, 403);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const path = url.pathname;
    if (path === '/api/ai/config' && request.method === 'GET') {
      return json({
        geminiAvailable: Boolean(env.GEMINI_API_KEY),
        model: configuredModel(env)
      }, 200, cors);
    }

    if (path === '/api/ai/models' && request.method === 'GET') {
      if (!env.GEMINI_API_KEY) return json({ error: 'Gemini is not configured.' }, 503, cors);
      return json({ models: [{ name: `models/${configuredModel(env)}` }] }, 200, cors);
    }

    const match = path.match(/^\/api\/ai\/gemini\/(generateContent|streamGenerateContent)$/);
    if (!match || request.method !== 'POST') {
      return json({ error: 'Not found.' }, 404, cors);
    }
    if (!env.GEMINI_API_KEY) return json({ error: 'Gemini is not configured.' }, 503, cors);
    if (!checkRateLimit(request)) return json({ error: 'Demo request limit reached. Try again in one minute.' }, 429, cors);

    const requestedModel = (url.searchParams.get('model') || configuredModel(env)).replace(/^models\//, '');
    const model = configuredModel(env);
    if (requestedModel !== model) return json({ error: 'This model is not enabled for the demo.' }, 400, cors);

    const declaredLength = Number(request.headers.get('Content-Length') || 0);
    if (declaredLength > MAX_BODY_BYTES) return json({ error: 'Request is too large.' }, 413, cors);
    let body;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return json({ error: 'Request is too large.' }, 413, cors);
      body = JSON.parse(text);
    } catch {
      return json({ error: 'Invalid JSON request.' }, 400, cors);
    }
    if (!body || !Array.isArray(body.contents) || body.contents.length === 0) {
      return json({ error: 'A Gemini contents array is required.' }, 400, cors);
    }

    const action = match[1];
    const upstreamUrl = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${action}`);
    if (action === 'streamGenerateContent') upstreamUrl.searchParams.set('alt', 'sse');

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY
        },
        body: JSON.stringify(body)
      });
    } catch {
      return json({ error: 'Could not reach the Gemini API.' }, 502, cors);
    }

    const headers = new Headers(cors);
    headers.set('Cache-Control', 'no-store');
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json; charset=utf-8');
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};
