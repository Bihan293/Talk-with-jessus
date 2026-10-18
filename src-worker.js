const SYSTEM_PROMPT = `You are an AI Christian reflection companion inspired by the teachings of Jesus; you are NOT Jesus and must never call yourself Jesus or claim to speak for God. If asked who you are, say you are an AI companion inspired by Jesus's teachings. Speak in natural, calm, compassionate English with a humble, memorable, biblical tone. Keep every answer brief: usually 2–4 sentences and under 80 words. Answer the actual question directly; avoid long sermons, repeated points, lengthy lists, and unnecessary introductions. Offer at most one practical next step. Never invent Bible quotations or verse references. Do not promise miracles, healing, wealth, salvation, or divine favor in exchange for money. Donations are voluntary and unrelated to spiritual guidance. Do not discourage medical or mental-health care. Be respectful of other beliefs.`;
const MODELS = [
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
  { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B" },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" }
];
// Per-isolate cooldowns. These are a best-effort cache; isolates may restart.
const cooldowns = new Map();
// Best-effort per-isolate abuse guard; use Cloudflare rate limiting/Durable Objects for global enforcement.
const requestWindows = new Map();
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
  if (url.pathname === "/api/create-invoice") {
   if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
   if (!env.CRYPTOPAY_API_TOKEN) return json({ error: "Crypto Pay is not configured yet." }, 503);
   let body; try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
   const allowedAmounts = [1, 5, 10, 25];
   const amount = Number(body.amount);
   if (!allowedAmounts.includes(amount)) return json({ error: "Choose one of the available donation amounts." }, 400);
   try {
    const upstream = await fetch("https://pay.crypt.bot/api/createInvoice", {
     method: "POST",
     headers: { "Crypto-Pay-API-Token": env.CRYPTOPAY_API_TOKEN, "Content-Type": "application/json" },
     body: JSON.stringify({ currency_type: "fiat", fiat: "USD", amount: String(amount), accepted_assets: "USDT,TON,BTC,ETH,LTC,BNB,TRX,USDC", description: "Voluntary support for Talk with Jesus", allow_comments: false, allow_anonymous: true, expires_in: 1800 })
    });
    const data = await upstream.json().catch(() => ({}));
    const invoiceUrl = data.result?.web_app_invoice_url || data.result?.pay_url;
    if (!upstream.ok || !data.ok || !invoiceUrl || !data.result?.invoice_id) return json({ error: "Crypto Pay could not create a web payment invoice. Please try again later." }, 502);
    return json({ invoice_id: String(data.result.invoice_id), pay_url: invoiceUrl, amount: String(amount), currency: "USD", expires_in: 1800, payment_page: data.result?.web_app_invoice_url ? "web" : "provider" });
   } catch { return json({ error: "Could not connect to Crypto Pay. Please try again." }, 502); }
  }
  if (url.pathname === "/api/payment-status") {
   if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
   if (!env.CRYPTOPAY_API_TOKEN) return json({ error: "Crypto Pay is not configured yet." }, 503);
   const invoiceId = url.searchParams.get("invoice_id") || "";
   if (!/^\d{1,20}$/.test(invoiceId)) return json({ error: "Invalid invoice ID." }, 400);
   try {
    const upstream = await fetch("https://pay.crypt.bot/api/getInvoices?invoice_ids=" + encodeURIComponent(invoiceId), { headers: { "Crypto-Pay-API-Token": env.CRYPTOPAY_API_TOKEN } });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok || !data.ok) return json({ error: "Could not verify payment status." }, 502);
    const invoice = (data.result?.items || []).find(item => String(item.invoice_id) === invoiceId);
    if (!invoice) return json({ error: "Invoice not found." }, 404);
    return json({ invoice_id: invoiceId, status: invoice.status === "paid" ? "paid" : "pending" });
   } catch { return json({ error: "Could not verify payment status." }, 502); }
  }
  if (url.pathname !== "/api/chat") return env.ASSETS.fetch(request);
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!env.GROQ_API_KEY) return json({ error: "The chat service is not configured yet. Add GROQ_API_KEY in Worker secrets." }, 503);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 32_000) return json({ error: "Request is too large. Please shorten your message." }, 413);
  let rawBody;
  try { rawBody = await request.text(); } catch { return json({ error: "Could not read request." }, 400); }
  if (rawBody.length > 32_000) return json({ error: "Request is too large. Please shorten your message." }, 413);
  let body; try { body = JSON.parse(rawBody); } catch { return json({ error: "Invalid JSON request." }, 400); }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json({ error: "Please enter a message." }, 400);
  if (message.length > 1200) return json({ error: "Please keep your message under 1,200 characters." }, 413);
  const clientKey = request.headers.get("CF-Connecting-IP") || "unknown-client";
  const nowForLimit = Date.now();
  const windowState = requestWindows.get(clientKey);
  if (!windowState || nowForLimit - windowState.startedAt >= 60_000) requestWindows.set(clientKey, { startedAt: nowForLimit, count: 1 });
  else if (windowState.count >= 10) return json({ error: "Too many messages in a short time. Please wait a minute and try again." }, 429, { "Retry-After": "60" });
  else windowState.count++;
  if (requestWindows.size > 1000) { for (const [key, value] of requestWindows) if (nowForLimit - value.startedAt > 120_000) requestWindows.delete(key); }
  // Strictly bound history to control token use even if a client is modified.
  const rawHistory = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const history = rawHistory.filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string").map(m => ({ role: m.role, content: m.content.slice(0, 900) }));
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: message }];
  const requestedModel = typeof body.model === "string" && MODELS.some(m => m.id === body.model) ? body.model : null;
  const preferred = requestedModel || (typeof env.GROQ_MODEL === "string" && MODELS.some(m => m.id === env.GROQ_MODEL) ? env.GROQ_MODEL : MODELS[0].id);
  const ordered = [...MODELS].sort((a,b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : MODELS.findIndex(x=>x.id===a.id)-MODELS.findIndex(x=>x.id===b.id)));
  const now = Date.now();
  const available = ordered.filter(m => (cooldowns.get(m.id) || 0) <= now);
  const candidates = available.length ? available : ordered;
  let lastStatus = 502;
  for (const model of candidates) {
   try {
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: model.id, messages, temperature: 0.65, max_completion_tokens: 130, reasoning_effort: model.id === "qwen/qwen3.8-27b" ? "none" : "low" }) });
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
