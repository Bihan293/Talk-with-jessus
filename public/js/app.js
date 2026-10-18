(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const messagesEl = $('messages'), input = $('message'), sendBtn = $('sendBtn'), form = $('composer'), chips = $('chips');
const STORE = 'bobbyray_v1';
const MAX_HISTORY = 10;

/* ---------------- State ---------------- */
const randAsk = () => 5 + Math.floor(Math.random() * 6); // every 5–10 user messages
let state = load() || { history: [], userCount: 0, nextAsk: randAsk(), supporter: false, invoice: null };
function load(){ try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } }
function save(){ try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} }

const GREETING = "Well HALLELUJAH, friend! Welcome to the Prosperity Hour! 🙌 Pastor Bobby Ray Goodwin here, comin' to you live from the Golden Harvest Mega-Ministry in Texas. The Spirit is tellin' me you didn't land here by accident, no sir. So go on — what's weighin' on your heart tonight?";

/* ---------------- Rendering ---------------- */
function escapeHtml(t){ return t.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function addMsg(role, text, opts = {}){
  const row = document.createElement('div');
  row.className = 'msg ' + (role === 'user' ? 'user' : 'bot') + (opts.error ? ' error' : '');
  if (role !== 'user') row.innerHTML = '<div class="ava">BR</div>';
  const wrap = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (opts.typing) bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  else bubble.innerHTML = escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  wrap.appendChild(bubble);
  if (opts.offer) wrap.appendChild(offerCard());
  row.appendChild(wrap);
  messagesEl.appendChild(row);
  scrollDown();
  return { row, bubble, wrap };
}
function offerCard(){
  const d = document.createElement('div');
  d.className = 'offer';
  d.innerHTML = '<div class="o-text"><b>🙏 Sow a $25 Seed of Faith</b>Secure checkout · about 1 minute</div>' +
    '<button class="btn btn-gold btn-shine" type="button">Sow $25 →</button>';
  d.querySelector('button').addEventListener('click', () => openDonate(25));
  return d;
}
function scrollDown(){ requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; }); }
function typeInto(bubble, text){
  return new Promise(res => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { bubble.textContent = text; return res(); }
    let i = 0; bubble.textContent = '';
    const step = () => { i = Math.min(text.length, i + 3); bubble.textContent = text.slice(0, i); scrollDown(); i < text.length ? setTimeout(step, 14) : res(); };
    step();
  });
}
function renderAll(){
  messagesEl.innerHTML = '';
  addMsg('bot', GREETING);
  state.history.forEach(m => addMsg(m.role, m.content, { offer: m.offer }));
  chips.hidden = state.history.length > 0;
}

/* ---------------- Chat ---------------- */
let busy = false;
async function send(text){
  text = (text || '').trim();
  if (!text || busy) return;
  busy = true; sendBtn.disabled = true; chips.hidden = true;
  input.value = ''; autosize();
  addMsg('user', text);
  state.userCount++;
  const ask = state.userCount >= state.nextAsk;
  const historyForApi = state.history.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
  state.history.push({ role: 'user', content: text }); save();
  const pending = addMsg('bot', '', { typing: true });
  setStatus('typing');
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: historyForApi, ask_donation: ask, supporter: state.supporter }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'The ministry line is busy. Try again in a moment.');
    const reply = data.reply || 'Well, the Spirit went quiet on me, friend. Say that again?';
    await typeInto(pending.bubble, reply);
    if (ask) { pending.wrap.appendChild(offerCard()); state.userCount = 0; state.nextAsk = randAsk(); scrollDown(); }
    state.history.push({ role: 'assistant', content: reply, offer: ask });
    state.history = state.history.slice(-30);
    save();
    speak(reply);
  } catch (e) {
    state.userCount = Math.max(0, state.userCount - 1);
    pending.row.classList.add('error');
    pending.bubble.textContent = e.message || 'Connection error. Please try again.';
  } finally {
    busy = false; sendBtn.disabled = false; setStatus(); input.focus({ preventScroll: true });
  }
}
function setStatus(mode){
  $('statusLine').innerHTML = mode === 'typing'
    ? '<i class="dot"></i> Pastor is preachin\u2019 a reply…'
    : state.supporter ? '<i class="dot"></i> Online · 👑 You are a VIP partner' : '<i class="dot"></i> Online · ready to bless you';
}
form.addEventListener('submit', e => { e.preventDefault(); send(input.value); });
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
function autosize(){ input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; }
input.addEventListener('input', autosize);
chips.querySelectorAll('[data-prompt]').forEach(b => b.addEventListener('click', () => send(b.dataset.prompt)));
$('resetChat').addEventListener('click', () => {
  if (state.history.length && !confirm('Start a new conversation?')) return;
  state.history = []; state.userCount = 0; state.nextAsk = randAsk(); save(); renderAll();
});

/* ---------------- Voice (browser TTS) ---------------- */
let voiceOn = false;
$('voiceToggle').addEventListener('click', e => {
  voiceOn = !voiceOn; e.currentTarget.setAttribute('aria-pressed', voiceOn); e.currentTarget.textContent = voiceOn ? '🔊' : '🔈';
  if (!voiceOn && 'speechSynthesis' in window) speechSynthesis.cancel();
  toast(voiceOn ? 'Voice on — Bobby Ray will read his replies aloud' : 'Voice off');
});
function speak(text){
  if (!voiceOn || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[*_#]/g, ''));
  const vs = speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang));
  u.voice = vs.find(v => /male|daniel|fred|alex|guy|david/i.test(v.name)) || vs[0] || null;
  u.lang = 'en-US'; u.rate = 1.02; u.pitch = 0.85;
  if (musicGain) duck(true); u.onend = u.onerror = () => duck(false);
  speechSynthesis.speak(u);
}

/* ---------------- Gospel organ music (Web Audio, no files) ---------------- */
let ctx = null, musicGain = null, musicOn = false, loopTimer = null, nextTime = 0, bar = 0;
const VOL = 0.16;
// I – IV – I – V  /  vi – IV – I – V  in C (warm gospel vamp)
const PROG = [[48,52,55,60,64],[53,57,60,65,69],[48,52,55,60,67],[55,59,62,67,71],[57,60,64,69,72],[53,57,60,65,69],[48,52,55,64,67],[55,59,62,65,71]];
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
function buildReverb(){
  const len = ctx.sampleRate * 3.2, buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
  const conv = ctx.createConvolver(); conv.buffer = buf; return conv;
}
let bus = null;
function initAudio(){
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
  ctx = new AC();
  musicGain = ctx.createGain(); musicGain.gain.value = 0;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
  bus = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 0.55;
  const wet = ctx.createGain(); wet.gain.value = 0.6;
  const rev = buildReverb();
  bus.connect(lp); lp.connect(dry); lp.connect(rev); rev.connect(wet);
  dry.connect(comp); wet.connect(comp); comp.connect(musicGain); musicGain.connect(ctx.destination);
  return true;
}
function organChord(notes, t, dur){
  // Drawbar-style organ: fundamental + octave + fifth harmonics, with slow Leslie-like vibrato
  const lfo = ctx.createOscillator(), lfoG = ctx.createGain(); lfo.frequency.value = 5.6; lfoG.gain.value = 2.2; lfo.connect(lfoG);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(0.11, t + 0.25);
  env.gain.setValueAtTime(0.11, t + dur - 0.35);
  env.gain.linearRampToValueAtTime(0.0001, t + dur + 0.25);
  env.connect(bus);
  notes.forEach((m, idx) => {
    [[1, 1], [2, 0.45], [3, 0.22], [4, 0.12]].forEach(([h, g]) => {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'sine'; o.frequency.value = mtof(m) * h;
      lfoG.connect(o.detune); og.gain.value = g * (idx === 0 ? 0.9 : 0.55);
      o.connect(og); og.connect(env); o.start(t); o.stop(t + dur + 0.4);
    });
  });
  // soft bass on root
  const b = ctx.createOscillator(), bg = ctx.createGain(); b.type = 'triangle'; b.frequency.value = mtof(notes[0] - 12);
  bg.gain.setValueAtTime(0.0001, t); bg.gain.linearRampToValueAtTime(0.18, t + 0.04); bg.gain.exponentialRampToValueAtTime(0.02, t + dur);
  b.connect(bg); bg.connect(bus); b.start(t); b.stop(t + dur + 0.1);
  lfo.start(t); lfo.stop(t + dur + 0.4);
  // gentle bell melody on top
  if (bar % 2 === 0) { const top = notes[notes.length - 1] + 12; bell(top, t + dur * 0.5); bell(top - (bar % 4 ? 3 : 5), t + dur * 0.75); }
}
function bell(m, t){
  const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = mtof(m);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
  o.connect(g); g.connect(bus); o.start(t); o.stop(t + 1.7);
}
function scheduler(){
  const BAR = 2.6;
  while (nextTime < ctx.currentTime + 1.5) { organChord(PROG[bar % PROG.length], nextTime, BAR); nextTime += BAR; bar++; }
  loopTimer = setTimeout(scheduler, 400);
}
async function startMusic(){
  if (!ctx && !initAudio()) return toast('Audio is not supported in this browser');
  if (ctx.state === 'suspended') await ctx.resume();
  musicOn = true; nextTime = ctx.currentTime + 0.1; scheduler();
  musicGain.gain.cancelScheduledValues(ctx.currentTime); musicGain.gain.setTargetAtTime(VOL, ctx.currentTime, 0.8);
  $('musicToggle').setAttribute('aria-pressed', 'true');
}
function stopMusic(){
  musicOn = false; clearTimeout(loopTimer);
  if (ctx) musicGain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
  $('musicToggle').setAttribute('aria-pressed', 'false');
}
function duck(on){ if (ctx && musicOn) musicGain.gain.setTargetAtTime(on ? VOL * 0.35 : VOL, ctx.currentTime, 0.2); }
$('musicToggle').addEventListener('click', () => musicOn ? stopMusic() : startMusic());
document.addEventListener('visibilitychange', () => { if (document.hidden && musicOn && ctx) ctx.suspend(); else if (!document.hidden && musicOn && ctx) ctx.resume(); });

/* ---------------- Donation ---------------- */
const modal = $('donationModal'), thanks = $('thanksModal'), status = $('donateStatus');
const customInput = $('customAmount'), payBtn = $('continueDonate'), checkBtn = $('checkPayment');
let amount = 25;
const fmt = n => '$' + (Number.isInteger(n) ? n : n.toFixed(2));
function setAmount(n){ amount = n; $('payAmount').textContent = fmt(n); }
function openDonate(n){
  status.textContent = '';
  if (n) { setAmount(n); customInput.value = ''; document.querySelectorAll('[data-amount]').forEach(b => b.classList.toggle('selected', Number(b.dataset.amount) === n)); }
  checkBtn.hidden = !state.invoice;
  modal.hidden = false; document.body.style.overflow = 'hidden';
  setTimeout(() => payBtn.focus(), 50);
}
function closeAll(){ modal.hidden = true; thanks.hidden = true; document.body.style.overflow = ''; }
document.querySelectorAll('[data-donate]').forEach(b => b.addEventListener('click', () => openDonate(25)));
$('closeModal').addEventListener('click', closeAll);
$('thanksClose').addEventListener('click', closeAll);
[modal, thanks].forEach(m => m.addEventListener('click', e => { if (e.target === m) closeAll(); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
document.querySelectorAll('[data-amount]').forEach(b => b.addEventListener('click', () => {
  customInput.value = ''; setAmount(Number(b.dataset.amount));
  document.querySelectorAll('[data-amount]').forEach(x => x.classList.toggle('selected', x === b));
}));
customInput.addEventListener('input', () => {
  const v = Number(customInput.value);
  if (customInput.value && Number.isFinite(v) && v >= 25) { setAmount(Math.round(v * 100) / 100); document.querySelectorAll('[data-amount]').forEach(x => x.classList.remove('selected')); }
});
payBtn.addEventListener('click', async () => {
  if (customInput.value.trim()) {
    const v = Number(customInput.value);
    if (!Number.isFinite(v) || v < 25) { status.textContent = 'The minimum seed is $25.'; customInput.focus(); return; }
    setAmount(Math.round(v * 100) / 100);
  }
  payBtn.disabled = true; const label = payBtn.innerHTML; payBtn.textContent = 'Opening secure checkout…'; status.textContent = '';
  try {
    const r = await fetch('/api/create-invoice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.pay_url) throw new Error(data.error || 'Could not open the payment page. Please try again.');
    state.invoice = data.invoice_id; save();
    window.location.href = data.pay_url;
  } catch (e) {
    status.textContent = e.message; payBtn.disabled = false; payBtn.innerHTML = label;
  }
});
async function checkPayment(silent){
  if (!state.invoice) return false;
  if (!silent) { checkBtn.disabled = true; status.textContent = 'Checking…'; }
  try {
    const r = await fetch('/api/payment-status?invoice_id=' + encodeURIComponent(state.invoice), { cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.status === 'paid') { markPaid(); return true; }
    if (!silent) status.textContent = 'Not confirmed yet — blockchain confirmations can take a few minutes. Try again shortly.';
  } catch { if (!silent) status.textContent = 'Could not check status right now.'; }
  finally { checkBtn.disabled = false; }
  return false;
}
checkBtn.addEventListener('click', () => checkPayment(false));
function markPaid(){
  state.supporter = true; state.invoice = null; save(); setStatus();
  $('thanksTitle').textContent = 'HALLELUJAH! Seed received!';
  $('thanksText').textContent = "Your seed has been confirmed. You're officially a VIP partner of the Golden Harvest Ministry — Bobby Ray will treat you like royalty! 👑";
  modal.hidden = true; thanks.hidden = false;
}
// Returning from NOWPayments
(function handleReturn(){
  const p = new URLSearchParams(location.search).get('payment');
  if (!p) return;
  history.replaceState(null, '', location.pathname);
  if (p === 'success') {
    thanks.hidden = false;
    let tries = 0;
    const poll = async () => { if (await checkPayment(true) || ++tries > 20) return; setTimeout(poll, 15000); };
    poll();
  } else if (p === 'cancelled') {
    toast('Payment cancelled — no worries, the button is always here 🙏');
  }
})();

/* ---------------- Toast ---------------- */
let toastT;
function toast(msg){ const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }

/* ---------------- Init ---------------- */
renderAll(); setStatus();
if (state.supporter === false && state.invoice) checkPayment(true);
})();
