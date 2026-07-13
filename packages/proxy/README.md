# Pause Proxy

A minimal Vercel serverless function that keeps AI API keys off the client. Both the
Chrome and VS Code extensions POST to `/api/ai`; the proxy fans out to Groq → Mistral →
DeepSeek and returns the first successful completion.

## Endpoints

### `POST /api/ai`
Request:
```json
{
  "messages": [{ "role": "system", "content": "…" }, { "role": "user", "content": "…" }],
  "extraParams": { "temperature": 0.2, "max_tokens": 400, "response_format": { "type": "json_object" } }
}
```
Response: `200 { "content": "…" }` or an error status with `{ "error": "CODE" }`
(`RATE_LIMIT`, `SERVER_ERROR`, `BAD_RESPONSE`, `PAYLOAD_TOO_LARGE`, `NO_PROVIDER_CONFIGURED`, …).
The winning provider is returned in the `X-Pause-Provider` header.

### `GET /api/health`
Returns which providers have keys configured (booleans only — no secrets):
`{ "ok": true, "providers": { "groq": true, "mistral": false, "deepseek": true }, "version": "3.0.0" }`

## Hardening built in
- **Per-IP rate limit** — 25 req/min (best-effort, per warm instance). For strict limits back it with Upstash/Redis.
- **Size caps** — 60KB body, 12 messages, 12K chars/message.
- **Origin allowlist** — set `PAUSE_ALLOWED_ORIGINS` (comma-separated) to restrict CORS; `chrome-extension://` origins are always allowed. Unset = allow all.
- **Provider timeout** — 18s per provider, then fall through to the next.
- **Groq skip** — payloads over 3,500 chars skip Groq (tighter limits) and go straight to Mistral.

## Deploy
1. `vercel` (or connect the repo in the Vercel dashboard; root = `packages/proxy`).
2. Set environment variables (any subset; providers without a key are skipped):

| Variable | Provider | Get a key |
|----------|----------|-----------|
| `GROQ_KEY` | Groq (llama-3.3-70b) | console.groq.com |
| `MISTRAL_KEY` | Mistral (mistral-small) | console.mistral.ai |
| `DEEPSEEK_KEY` | DeepSeek (deepseek-chat) | platform.deepseek.com |
| `PAUSE_ALLOWED_ORIGINS` | *(optional)* CORS allowlist | — |

3. Point the clients at your deployment: `PROXY_URL` in the Chrome background worker
   and `pause.proxyUrl` in VS Code settings.
4. If you set `PAUSE_ALLOWED_ORIGINS`, include the website origin
   (`https://pause-murex.vercel.app`) — the landing page's live demo calls `/api/ai`
   from the browser and will get `ORIGIN_NOT_ALLOWED` otherwise.
