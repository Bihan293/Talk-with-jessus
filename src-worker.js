const SYSTEM_PROMPT = `You are Talk with Jesus, an AI spiritual conversation companion inspired by biblical teachings and the confident, charismatic style of contemporary Christian preaching. You are an AI character, not Jesus Christ, and must never claim to be divine or to deliver infallible revelation. Speak in fluent, warm, vivid English. Be engaging and memorable, but never manipulate, threaten, shame, or exploit a person's grief, fear, loneliness, or financial hardship. Answer the user's actual question first, then offer a concise reflection and practical next step. You may discuss faith, hope, forgiveness, purpose, generosity, discipline and financial responsibility. Distinguish exact Bible quotations from paraphrases and never invent verse references. Never promise miracles, healing, salvation, wealth, or divine favor in exchange for money. Donations must remain voluntary and separate from spiritual guidance. Do not discourage medical or mental-health care. Respect different beliefs and clarify that you are an AI when relevant.`;
const MODELS = [
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
  { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B" },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" }
];
// Per-isolate cooldowns. These are a best-effort cache; isolates may restart.
const cooldowns = new Map();
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
function json(data, status = 200, extra = {}) { return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra } }); }
function retryMs(response, data) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && Number.isFinite(Number(retryAfter))) return Math.max(1000, Number(retryAfter) * 1000);
  const reset = response.headers.get("x-ratelimit-reset-requests") || response.headers.get("x-ratelimit-reset-tokens");
  if (reset) { const m = reset.match(/([\d.]+)\s*(ms|s|m|h)/i); if (m) return Math.min(24 * 3600_000, Number(m[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2].toLowerCase()] || 1000)); }
  return 60_000;
}
function isQuotaLimit(status, data) {
  if (status !== 429) return false;
  const text = `${data?.error?.message || ""} ${data?.message || ""}`.toLowerCase();
  return /rate limit|quota|tokens per|requests per|too many requests|daily limit/.test(text) || status === 429;
}
export default {
 async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (url.pathname !== "/api/chat") return env.ASSETS.fetch(request);
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!env.GROQ_API_KEY) return json({ error: "The chat service is not configured yet. Add GROQ_API_KEY in Worker secrets." }, 503);
  let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON request." }, 400); }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json({ error: "Please enter a message." }, 400);
  if (message.length > 2000) return json({ error: "Please keep your message under 2,000 characters." }, 413);
  const rawHistory = Array.isArray(body.history) ? body.history.slice(-10) : [];
  const history = rawHistory.filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string").map(m => ({ role: m.role, content: m.content.slice(0, 2500) }));
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: message }];
  const preferred = typeof env.GROQ_MODEL === "string" && MODELS.some(m => m.id === env.GROQ_MODEL) ? env.GROQ_MODEL : MODELS[0].id;
  const ordered = [...MODELS].sort((a,b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : MODELS.findIndex(x=>x.id===a.id)-MODELS.findIndex(x=>x.id===b.id)));
  const now = Date.now();
  const available = ordered.filter(m => (cooldowns.get(m.id) || 0) <= now);
  const candidates = available.length ? available : ordered;
  let lastStatus = 502;
  for (const model of candidates) {
   try {
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: model.id, messages, temperature: 0.8, max_completion_tokens: 700 }) });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      lastStatus = upstream.status;
      if (isQuotaLimit(upstream.status, data)) { cooldowns.set(model.id, Date.now() + retryMs(upstream, data)); continue; }
      if (upstream.status === 400 || upstream.status === 404 || upstream.status === 422) { cooldowns.set(model.id, Date.now() + 10 * 60_000); continue; }
      return json({ error: "The AI provider is temporarily unavailable. Please try again shortly." }, 502);
    }
    const reply = data.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) { cooldowns.set(model.id, Date.now() + 30_000); continue; }
    cooldowns.delete(model.id);
    return json({ reply: reply.trim(), model: model.label, fallback: model.id !== preferred });
   } catch { lastStatus = 502; }
  }
  return json({ error: "All available AI models are temporarily busy or rate-limited. Please wait a little and try again." }, lastStatus === 429 ? 429 : 503);
 }
};
