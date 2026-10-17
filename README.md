# Talk with Jesus — Cloudflare Workers + Groq

## Deploy
1. Install Node.js on a computer and unzip this project.
2. In this folder, run `npm install -g wrangler` (or use `npx wrangler`).
3. Run `npx wrangler login` and complete the browser authorization.
4. Add the Groq key as a secret: `npx wrangler secret put GROQ_API_KEY` and paste the key when prompted.
5. Deploy: `npx wrangler deploy`.
6. Open the `*.workers.dev` URL printed by Wrangler.

Do not paste your API key into `public/index.html`, source control, or chat. `src-worker.js` keeps it server-side.

## Model
Default model is `openai/gpt-oss-20b`. Confirm the current model ID and quotas in https://console.groq.com/docs/models and https://console.groq.com/docs/rate-limits. Change `GROQ_MODEL` in `wrangler.toml` if needed, then redeploy.

## Notes
- Donation UI is still a non-payment prototype; no money is collected.
- Add abuse protection/rate limiting before public promotion. Current endpoint limits message length but does not yet implement per-user rate limiting.
- Groq account eligibility and terms must be followed. If account holder must be 18+, use a lawful adult account owner; do not falsify age.
