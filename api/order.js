import { newId, saveOrder } from './_lib/orders.js';
import { passOk, rateLimited, tooMany } from './_lib/guard.js';

// The quote form's send: saves the request to the admin order log and emails
// it through FormSubmit, from here rather than from the browser, so the
// FormSubmit address isn't in the page and a request without a bot-check pass
// (api/human.js) goes nowhere. Anyone can call it, so everything is
// size-capped and type-checked.
const LIMITS = { name: 120, team: 20, email: 200, part_type: 60, details: 4000, address: 300,
  quote_summary: 6000, price: 60, part: 400, design_file: 600, file_name: 200 };

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
const OPTIONS = ['tapped', 'tight_tolerances', 'complex_geometry'];
const PRICE_KEYS = ['material', 'machine', 'labor', 'flags', 'minimum', 'delivery', 'per_part', 'total'];
const MAX_FILES = 10;
// An uploaded design file lives in this project's public Blob store; anything
// else (a failed upload) is kept only as the "UPLOAD FAILED" note.
const FILE_URL = /^(https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/|UPLOAD FAILED)/;

// Where the email goes. FORMSUBMIT_TO can be the random-string alias FormSubmit
// offers after activation, to keep the real address private. FormSubmit
// activates a form per website, so the request names crackbotics.com as its
// origin (activated already).
const MAIL_TO = () => process.env.FORMSUBMIT_TO || 'anthonyhuynh980@gmail.com';
const MAIL_CC = () => process.env.FORMSUBMIT_CC ?? 'crackboticssandiego@gmail.com';
const MAIL_SITE = () => process.env.FORMSUBMIT_SITE || 'https://crackbotics.com';
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;

// The form's own fields, as the email table shows them. FormSubmit's control
// fields (names starting with "_") are set here, never taken from the request.
function mailFields(fields, order) {
  const out = {};
  if (fields && typeof fields === 'object') {
    for (const [k, v] of Object.entries(fields).slice(0, 50)) {
      if (FIELD_NAME.test(k) && typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 6000);
    }
  }
  out.name = order.name;
  out.email = order.email;
  if (!out.quote_summary && order.quote_summary) out.quote_summary = order.quote_summary;
  return { ...out, _subject: 'New quote request — Crackbotics', _template: 'table', ...(MAIL_CC() ? { _cc: MAIL_CC() } : {}) };
}

async function sendMail(fields) {
  try {
    const res = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(MAIL_TO()), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: MAIL_SITE(), referer: MAIL_SITE() + '/' },
      body: JSON.stringify(fields),
      signal: AbortSignal.timeout(20_000)
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && String(out.success) === 'true') return true;
    console.error('FormSubmit refused the email:', res.status, out.message || '');
  } catch (err) {
    console.error('FormSubmit send failed:', err);
  }
  return false;
}

function cleanPrice(p) {
  if (!p || typeof p !== 'object') return undefined;
  const out = { discount: p.discount === true };
  if (p.partial === true) out.partial = true;
  for (const k of PRICE_KEYS) out[k] = num(p[k], 0, 1e6) ?? 0;
  return out.total > 0 ? out : undefined; // every real quote has a total
}

// The structured spec record the quote form sends (what was ordered, even when it
// goes to a hand quote). Only known keys, types and sizes are kept.
function cleanSpecs(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {
    kind: ['cnc', 'print', 'other'].includes(s.kind) ? s.kind : 'other',
    qty: num(s.qty, 1, 100000) ?? 1,
    rush: s.rush === true,
    options: Array.isArray(s.options) ? [...new Set(s.options.filter((o) => OPTIONS.includes(o)))] : [],
    material: clip(s.material, 80), color: clip(s.color, 40), size: clip(s.size, 200),
    file_type: clip(s.file_type, 10), reason: clip(s.reason, 400),
    infill: num(s.infill, 0, 100), walls: num(s.walls, 1, 100)
  };
  const price = cleanPrice(s.price);
  if (price) out.price = price;
  // One entry per file: what it is, how many, what it measured, and its own
  // price or why it's priced by hand.
  if (Array.isArray(s.items)) {
    out.items = s.items.slice(0, MAX_FILES).filter((it) => it && typeof it === 'object').map((it) => {
      const item = { file: clip(it.file, 200), file_type: clip(it.file_type, 10), qty: num(it.qty, 1, 100000) ?? 1,
        size: clip(it.size, 200), reason: clip(it.reason, 400) };
      const p = cleanPrice(it.price);
      if (p) item.price = p;
      return item;
    });
  }
  return out;
}

export async function POST(request) {
  const raw = await request.text();
  if (rateLimited('order', request, 8, 10)) return tooMany();
  if (raw.length > 64_000) return Response.json({ error: 'Too large' }, { status: 413 });
  let body;
  try { body = JSON.parse(raw); } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Invalid request' }, { status: 400 });
  if (body._honey) return Response.json({ ok: true, emailed: true });
  if (!passOk(body.pass)) return Response.json({ error: 'Bot check missing or expired' }, { status: 403 });

  const order = { id: newId(), createdAt: new Date().toISOString(), status: 'new', notes: '' };
  for (const [field, max] of Object.entries(LIMITS)) order[field] = clip(body[field], max);
  order.delivery = body.delivery === 'delivery' ? 'delivery' : 'pickup';
  order.escalated = body.escalated === true;
  order.specs = cleanSpecs(body.specs);
  if (!order.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(order.email)) {
    return Response.json({ error: 'Name and a valid email are required' }, { status: 400 });
  }
  if (order.design_file && !FILE_URL.test(order.design_file)) order.design_file = '';
  // Every file in the request ({ name, url }), in the order they were added.
  order.files = (Array.isArray(body.files) ? body.files : []).slice(0, MAX_FILES)
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({ name: clip(f.name, 200), url: FILE_URL.test(clip(f.url, 600)) ? clip(f.url, 600) : '' }))
    .filter((f) => f.name || f.url);
  if (!order.files.length && (order.design_file || order.file_name)) order.files = [{ name: order.file_name, url: order.design_file }];
  const [saved, emailed] = await Promise.all([
    saveOrder(order).then(() => true, (err) => { console.error('Saving order failed:', err); return false; }),
    sendMail(mailFields(body.email_fields, order))
  ]);
  // If the email didn't go, the page posts the form to FormSubmit itself (the
  // way it used to), so the request still reaches the inbox.
  const fallback = emailed ? undefined : 'https://formsubmit.co/' + encodeURIComponent(MAIL_TO());
  if (!saved && !emailed) return Response.json({ error: 'Could not save or send', fallback }, { status: 502 });
  return Response.json({ ok: true, id: saved ? order.id : undefined, saved, emailed, fallback });
}
