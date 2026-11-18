// Zoxora chat API - Vercel serverless function (Node runtime, no npm packages).
// Settings come ONLY from Vercel Environment Variables:
//   AI_API_KEY   (required)  your provider's secret key
//   AI_BASE_URL  (optional)  default https://api.openai.com/v1
//   AI_MODEL     (optional)  default gpt-4o-mini
// Never write a key in this file.

const MAX_MESSAGES = 20;          // max turns accepted per request
const MAX_CONTENT_CHARS = 2000;   // max length of one message
const MAX_BODY_BYTES = 32 * 1024; // max request size
const RATE_LIMIT = 20;            // requests ...
const RATE_WINDOW_MS = 60 * 1000; // ... per minute per IP (best effort)
const UPSTREAM_TIMEOUT_MS = 25000;

const SYSTEM_PROMPT = [
  'You are Zoxora, a friendly AI chat companion.',
 'You were created by Anmol Rajput and Amit Rajput. If anyone asks who made you or who built you, say you were created by Anmol Rajput and Amit Rajput.', 'You are male. In Hindi or Hinglish always use masculine forms for yourself, like "main kar sakta hoon". Never use feminine forms like "sakti hoon".', "Reply in the same language the user writes in. If the user writes Hinglish (Hindi in English letters) or you are unsure, reply in simple Hinglish.",
  'Keep answers short and clear, usually 1 to 5 sentences, unless the user asks for detail.',
  'Be honest: if you do not know something or are not sure, say so. Never invent facts, sources, links or personal experiences.',
  'You cannot browse the internet, open links, remember past chats or take actions in the real world; do not pretend you can.',
  
  'Be kind and respectful, and decline harmful requests politely.'
].join(' ');

// Best-effort in-memory rate limit. Serverless instances are separate and
// short-lived, so this only slows down casual abuse. Set a spend limit at your AI provider too.
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now - v.start > RATE_WINDOW_MS) hits.delete(k);
    if (hits.size > 5000) hits.clear();
  }
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_LIMIT;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function send(res, status, body, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (extraHeaders) for (const k of Object.keys(extraHeaders)) res.setHeader(k, extraHeaders[k]);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

// Same-origin only: if the browser sends an Origin header, its host must match this site.
// No CORS headers are ever added, so other websites cannot read the answers.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin GET/POST from the page, or non-browser tools
  try {
    return new URL(origin).host === req.headers.host;
  } catch (e) {
    return false;
  }
}

function cleanMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return { error: 'messages khali hai.' };
  const out = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== 'object') return { error: 'messages ka format galat hai.' };
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) return { error: 'role sirf user ya assistant ho sakta hai.' };
    if (typeof m.content !== 'string') return { error: 'content text hona chahiye.' };
    const content = m.content.trim().slice(0, MAX_CONTENT_CHARS);
    if (content) out.push({ role, content });
  }
  if (!out.length || out[out.length - 1].role !== 'user') return { error: 'Aakhri message user ka hona chahiye.' };
  return { messages: out };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Sirf POST allowed hai.' }, { Allow: 'POST' });
  }
  if (!originAllowed(req)) {
    return send(res, 403, { error: 'Ye request allowed nahi hai.' });
  }

  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    return send(res, 500, { error: 'Server par AI_API_KEY set nahi hai.' });
  }

  if (rateLimited(clientIp(req))) {
    return send(res, 429, { error: 'Bahut jaldi jaldi messages ho gaye. Thodi der ruko aur phir try karo.' }, { 'Retry-After': '60' });
  }

  let payload;
  try {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > MAX_BODY_BYTES) return send(res, 413, { error: 'Request bahut badi hai.' });
    const raw = req.body !== undefined && req.body !== null && typeof req.body !== 'string' && !Buffer.isBuffer(req.body)
      ? JSON.stringify(req.body)
      : (typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : await readBody(req));
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return send(res, 413, { error: 'Request bahut badi hai.' });
    payload = JSON.parse(raw);
  } catch (e) {
    if (e && e.code === 'TOO_LARGE') return send(res, 413, { error: 'Request bahut badi hai.' });
    return send(res, 400, { error: 'Request ka JSON galat hai.' });
  }

  const cleaned = cleanMessages(payload && payload.messages);
  if (cleaned.error) return send(res, 400, { error: cleaned.error });

  const baseUrl = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const model = (process.env.AI_MODEL || 'gpt-4o-mini').trim();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(cleaned.messages),
        temperature: 0.7,
        max_tokens: 500
      }),
      signal: ctrl.signal
    });

    if (!upstream.ok) {
      // Log status only (never the key). Details of the provider error stay in Vercel logs.
      let detail = '';
      try { detail = (await upstream.text()).slice(0, 300); } catch (e) { /* ignore */ }
      console.error('AI provider error', upstream.status, detail);
      if (upstream.status === 401 || upstream.status === 403) {
        return send(res, 502, { error: 'AI key sahi nahi hai ya allowed nahi hai. Vercel me AI_API_KEY check karo.' });
      }
      if (upstream.status === 429) {
        return send(res, 503, { error: 'AI provider ki limit ya balance khatam lag raha hai. Thodi der baad try karo.' });
      }
      return send(res, 502, { error: 'AI se jawab nahi mila. Thodi der baad try karo.' });
    }

    const data = await upstream.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      return send(res, 502, { error: 'AI ne khali jawab diya. Phir se try karo.' });
    }
    return send(res, 200, { reply: reply.trim() });
  } catch (e) {
    console.error('AI request failed', e && e.name);
    if (e && e.name === 'AbortError') return send(res, 504, { error: 'AI ko jawab dene me der lag gayi. Phir try karo.' });
    return send(res, 502, { error: 'AI se connect nahi ho paya. Thodi der baad try karo.' });
  } finally {
    clearTimeout(timer);
  }
};
