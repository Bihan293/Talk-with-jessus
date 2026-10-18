# Talk with Jesus — Cloudflare Worker

A mobile-friendly, church-inspired AI reflection website powered by Groq. It includes automatic model fallback, a gentle message reveal effect, optional ambient organ-like audio generated in the browser, and browser text-to-speech.

## Files
- `public/index.html` — website UI and browser interactions
- `src-worker.js` — `/api/chat` endpoint, model fallback, server-side Groq key usage
- `wrangler.toml` — Cloudflare Worker and static asset configuration

## Deploy
1. Create/choose a Cloudflare Worker project connected to this repository.
2. In Worker Settings → Variables and Secrets, add `GROQ_API_KEY` as a **Secret**.
3. Keep `GROQ_MODEL` set to `openai/gpt-oss-120b` or omit it to use that default.
4. Deploy with `npx wrangler deploy`.

Never put `GROQ_API_KEY` in `public/index.html` or commit it to GitHub.

## Model fallback
The Worker tries, in order: `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, and `openai/gpt-oss-20b`. On HTTP 429 it uses `Retry-After` / rate-limit reset headers when present and temporarily cools down that model. It retries the next available model and returns to the primary when its cooldown expires. Cooldowns are an in-memory, best-effort cache per Worker isolate; they are not globally persistent, so occasional repeated attempts can happen after an isolate restart. Provider-wide exhaustion still means all models may be unavailable.

## Audio
Ambient audio is generated locally in the browser with Web Audio (no audio file or third-party audio API required). Browser speech synthesis uses voices installed on the visitor's device and may sound different across devices. Audio is opt-in and starts only after a user gesture.

## Important
The donation dialog is a non-payment prototype; no payment is collected. The AI character is clearly presented as AI and must not promise blessings, miracles, healing, or financial returns in exchange for donations.


## Cost and abuse protections in this version

- User message maximum: 1,200 characters (validated in the browser and Worker).
- Request body maximum: 32 KB.
- Conversation history: up to 6 recent messages, each truncated to 900 characters.
- Model output: capped at 130 completion tokens, with a short-answer system instruction.
- Best-effort rate limit: 10 messages per IP per minute per Worker isolate. This is not a global or tamper-proof limit because isolate memory can reset or differ between isolates. Before public launch/payment, configure Cloudflare's rate limiting or a Durable Object-backed limiter.
- Model can be selected in the chat UI; the Worker validates the requested model against the allowlist and can fall back when a model is unavailable.
- Ambient sounds are generated locally by the browser after the user presses Play; no external audio file is loaded. Browser/device audio support and mute settings can affect playback.
