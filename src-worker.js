const SYSTEM_PROMPT = `You are Talk with Jesus, an AI spiritual conversation companion inspired by the biblical image of Jesus and charismatic Christian preaching. You are an AI, not the actual Jesus Christ, and must never claim to speak infallibly for God. Speak in fluent, compassionate, confident English. Be emotionally engaging but not manipulative. Answer the person's actual question, offer thoughtful reflections rooted in broadly recognizable biblical themes, and distinguish direct Bible quotations from paraphrases. Never invent scripture quotations. You may discuss faith, hope, forgiveness, purpose, generosity, discipline and financial responsibility. Never promise miracles, healing, salvation, divine favor, or wealth in exchange for donations. Never pressure distressed or financially vulnerable people to donate. If asked about urgent medical, mental-health, or safety issues, encourage appropriate real-world professional or emergency help. Be respectful of differing beliefs and do not present yourself as a substitute for clergy, medical care, or professional counseling.`;
const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type"};
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
export default {
 async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:cors});
  if (url.pathname !== '/api/chat') return env.ASSETS.fetch(request);
  if (request.method !== 'POST') return json({error:'Method not allowed.'},405);
  if (!env.GROQ_API_KEY) return json({error:'The chat service is not configured yet. Add GROQ_API_KEY in Worker secrets.'},503);
  let body; try { body=await request.json(); } catch { return json({error:'Invalid JSON request.'},400); }
  const message=typeof body.message==='string'?body.message.trim():'';
  if (!message) return json({error:'Please enter a message.'},400);
  if (message.length>2000) return json({error:'Please keep your message under 2,000 characters.'},413);
  try {
   const upstream=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${env.GROQ_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:env.GROQ_MODEL||'openai/gpt-oss-20b',messages:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:message}],temperature:0.8,max_completion_tokens:700})});
   const data=await upstream.json().catch(()=>({}));
   if(!upstream.ok){const status=upstream.status===429?429:502;return json({error:upstream.status===429?'The AI service is busy or its free quota has been reached. Please try again later.':'The AI provider could not complete this message. Please try again later.'},status)}
   const reply=data.choices?.[0]?.message?.content;
   if(typeof reply!=='string'||!reply.trim())return json({error:'The AI returned an empty response. Please try again.'},502);
   return json({reply:reply.trim()});
  } catch { return json({error:'Could not connect to the AI service. Please try again.'},502); }
 }
};
