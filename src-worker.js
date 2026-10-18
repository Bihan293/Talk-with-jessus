import { neon } from "@neondatabase/serverless";
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
   if (!env.NOWPAYMENTS_API_KEY || !env.DATABASE_URL) return json({ error: "Payment service is not configured yet." }, 503);
   let body; try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
   const amount = Number(body.amount);
   if (!Number.isFinite(amount) || amount < 25 || Math.round(amount * 100) !== amount * 100) return json({ error: "The minimum payment is $25. Enter a valid amount with up to two decimal places." }, 400);
   const orderId = crypto.randomUUID();
   try {
    const sql = neon(env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS payments (order_id TEXT PRIMARY KEY, invoice_id TEXT, payment_id TEXT, amount NUMERIC(10,2) NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    // Create a hosted NOWPayments invoice so the supporter pays on the provider's website.
    const upstream = await fetch("https://api.nowpayments.io/v1/invoice", {
     method: "POST",
     headers: { "x-api-key": env.NOWPAYMENTS_API_KEY, "Content-Type": "application/json" },
     body: JSON.stringify({ price_amount: amount, price_currency: "usd", order_id: orderId, order_description: "Voluntary support for Talk with Jesus", ipn_callback_url: `${url.origin}/api/nowpayments-ipn`, success_url: `${url.origin}/?payment=success`, cancel_url: `${url.origin}/?payment=cancelled` })
    });
    const data = await upstream.json().catch(() => ({}));
    const paymentUrl = data.invoice_url || data.pay_url;
    if (!upstream.ok || !data.id || !paymentUrl) {
     const providerMessage = typeof data.message === "string" ? data.message.slice(0, 240) : "No hosted invoice URL was returned.";
     return json({ error: `NOWPayments could not create a hosted invoice: ${providerMessage}` }, 502);
    }
    await sql`INSERT INTO payments (order_id, invoice_id, payment_id, amount, status) VALUES (${orderId}, ${String(data.id)}, NULL, ${amount}, 'waiting')`;
    return json({ invoice_id: orderId, provider_invoice_id: String(data.id), pay_url: String(paymentUrl), amount: String(amount), currency: "USD", payment_page: "hosted" });
   } catch { return json({ error: "Could not create payment or save it to the database. Please try again later." }, 502); }
  }
  if (url.pathname === "/api/payment-status") {
   if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
   if (!env.DATABASE_URL) return json({ error: "Payment database is not configured." }, 503);
   const orderId = url.searchParams.get("invoice_id") || "";
   if (!/^[0-9a-f-]{36}$/i.test(orderId)) return json({ error: "Invalid order ID." }, 400);
   try {
    const sql = neon(env.DATABASE_URL);
    const rows = await sql`SELECT status FROM payments WHERE order_id = ${orderId} LIMIT 1`;
    if (!rows.length) return json({ error: "Payment not found." }, 404);
    return json({ invoice_id: orderId, status: rows[0].status === "finished" ? "paid" : "pending" });
   } catch { return json({ error: "Could not verify payment status." }, 502); }
  }
  if (url.pathname === "/api/nowpayments-ipn") {
   if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
   if (!env.DATABASE_URL || !env.NOWPAYMENTS_IPN_SECRET) return json({ error: "IPN is not configured." }, 503);
   const raw = await request.text();
   if (raw.length > 20000) return json({ error: "Payload too large." }, 413);
   let payload; try { payload = JSON.parse(raw); } catch { return json({ error: "Invalid JSON." }, 400); }
   const signature = request.headers.get("x-nowpayments-sig") || "";
   if (!signature || !payload || typeof payload !== "object" || Array.isArray(payload)) return json({ error: "Invalid signature or payload." }, 400);
   function sortObject(value) { if (Array.isArray(value)) return value.map(sortObject); if (value && typeof value === "object") return Object.keys(value).sort().reduce((o,k)=>(o[k]=sortObject(value[k]),o),{}); return value; }
   const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.NOWPAYMENTS_IPN_SECRET.trim()), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
   const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(sortObject(payload)))));
   const expected = Array.from(signed, b => b.toString(16).padStart(2,"0")).join("");
   if (expected.length !== signature.length || !crypto.subtle) return json({ error: "Invalid signature." }, 401);
   let mismatch = 0; for (let i=0;i<expected.length;i++) mismatch |= expected.charCodeAt(i) ^ signature.toLowerCase().charCodeAt(i);
   if (mismatch !== 0) return json({ error: "Invalid signature." }, 401);
   const orderId = String(payload.order_id || "");
   const paymentStatus = String(payload.payment_status || "").toLowerCase();
   if (!/^[0-9a-f-]{36}$/i.test(orderId)) return json({ error: "Unknown order." }, 400);
   const allowedStatuses = ["waiting", "confirming", "confirmed", "sending", "partially_paid", "finished", "failed", "refunded", "expired"];
   if (!allowedStatuses.includes(paymentStatus)) return json({ error: "Unknown payment status." }, 400);
   try {
    const sql = neon(env.DATABASE_URL);
    const rows = await sql`SELECT amount, payment_id FROM payments WHERE order_id = ${orderId} LIMIT 1`;
    if (!rows.length) return json({ error: "Unknown order." }, 404);
    if (payload.price_amount != null && Math.abs(Number(payload.price_amount) - Number(rows[0].amount)) > 0.01) return json({ error: "Payment amount mismatch." }, 400);
    if (payload.payment_id != null && rows[0].payment_id != null && String(payload.payment_id) !== String(rows[0].payment_id)) return json({ error: "Payment ID mismatch." }, 400);
    await sql`UPDATE payments SET payment_id = ${payload.payment_id == null ? rows[0].payment_id : String(payload.payment_id)}, status = ${paymentStatus}, updated_at = NOW() WHERE order_id = ${orderId}`;
    return json({ ok: true });
   } catch { return json({ error: "Could not update payment status." }, 502); }
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
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: model.id, messages, temperature: 0.65, max_completion_tokens: 220, reasoning_effort: model.id === "qwen/qwen3.8-27b" ? "none" : "low" }) });
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
