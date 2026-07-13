// Pause proxy — hardened Vercel serverless function.
// Fans out to Groq → Mistral → DeepSeek using server-side keys so no API keys
// ship in the extensions. Contract (matches @pause/core createProxyClient):
//   POST { messages: ChatMessage[], extraParams?: { temperature, max_tokens, response_format } }
//   → 200 { content: string }  |  4xx/5xx { error: CODE }
//
// Env: GROQ_KEY, MISTRAL_KEY, DEEPSEEK_KEY (any subset; providers with no key are skipped).
// Optional: PAUSE_ALLOWED_ORIGINS (comma-separated) to restrict CORS.

const MAX_BODY_BYTES = 60_000; // ~60KB request cap
const MAX_MESSAGES = 12;
const RATE_LIMIT = 25; // requests
const RATE_WINDOW_MS = 60_000; // per minute per IP (best-effort, per warm instance)

// Groq is skipped for large payloads (tighter rate limits there).
const GROQ_MAX_CHARS = 3500;

const PROVIDERS = [
  {
    name: 'groq',
    envKey: 'GROQ_KEY',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    skipIf: (chars) => chars > GROQ_MAX_CHARS,
  },
  {
    name: 'mistral',
    envKey: 'MISTRAL_KEY',
    url: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-small-latest',
  },
  {
    name: 'deepseek',
    envKey: 'DEEPSEEK_KEY',
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
  },
];

// ─── Best-effort in-memory rate limiter (per warm instance) ─────────────────────
const hits = new Map(); // ip → number[] (timestamps)
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // crude memory guard
  return arr.length > RATE_LIMIT;
}

function allowedOrigin(origin) {
  const list = (process.env.PAUSE_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return true; // no allowlist configured → allow all
  if (!origin) return true; // non-browser callers (extension SW) may omit Origin
  return list.includes(origin) || origin.startsWith('chrome-extension://');
}

function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (Array.isArray(xf) ? xf[0] : xf || '').split(',')[0].trim() || 'unknown';
}

async function callProvider(provider, messages, extraParams, signal) {
  const body = {
    model: provider.model,
    messages,
    temperature: clampNumber(extraParams.temperature, 0, 2, 0.3),
    max_tokens: clampNumber(extraParams.max_tokens, 1, 4000, 1024),
  };
  if (extraParams.response_format) body.response_format = extraParams.response_format;

  const resp = await fetch(provider.url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env[provider.envKey]}`,
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 429) throw new Error('RATE_LIMIT');
  if (resp.status >= 500) throw new Error('SERVER_ERROR');
  if (!resp.ok) throw new Error(`HTTP_${resp.status}`);

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('BAD_RESPONSE');
  return content;
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  setCors(res, origin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  if (!allowedOrigin(origin)) return res.status(403).json({ error: 'ORIGIN_NOT_ALLOWED' });
  if (rateLimited(clientIp(req))) return res.status(429).json({ error: 'RATE_LIMIT' });

  // Body may be pre-parsed (Vercel) or a stream. Guard size either way.
  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > MAX_BODY_BYTES) return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'BAD_JSON' });
    }
  }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }
  if (body.messages.length > MAX_MESSAGES) return res.status(400).json({ error: 'TOO_MANY_MESSAGES' });

  const messages = body.messages
    .filter((m) => m && typeof m.content === 'string' && typeof m.role === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 12000) }));
  const extraParams = body.extraParams && typeof body.extraParams === 'object' ? body.extraParams : {};
  const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
  if (totalChars > MAX_BODY_BYTES) return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });

  const available = PROVIDERS.filter((p) => process.env[p.envKey]);
  if (available.length === 0) return res.status(500).json({ error: 'NO_PROVIDER_CONFIGURED' });

  let lastError = 'SERVER_ERROR';
  for (const provider of available) {
    if (provider.skipIf && provider.skipIf(totalChars)) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18_000);
    try {
      const content = await callProvider(provider, messages, extraParams, controller.signal);
      clearTimeout(timer);
      res.setHeader('X-Pause-Provider', provider.name);
      return res.status(200).json({ content });
    } catch (err) {
      clearTimeout(timer);
      lastError = err && err.message ? err.message : 'SERVER_ERROR';
      // Try the next provider on any failure.
    }
  }
  return res.status(502).json({ error: lastError });
};
