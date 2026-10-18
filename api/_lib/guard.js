import crypto from 'node:crypto';

// Bot protection shared by the public quote endpoints (api/human.js,
// api/upload.js, api/order.js).
//
// - Cloudflare Turnstile: the quote form solves a challenge, api/human.js
//   checks it with Cloudflare once and hands back a signed pass, good for
//   PASS_MINUTES. The file uploads and the order then show that pass, so one
//   challenge covers every request a quote makes (a Turnstile token can only
//   be checked once). On only when both TURNSTILE_SITE_KEY and
//   TURNSTILE_SECRET_KEY are set, so the form keeps working until they are.
// - Rate limits per IP address. They're kept in the function's memory, so
//   they catch bursts from one address but reset when Vercel starts a new
//   instance; the Vercel Firewall is the hard limit (see README).

const PASS_MINUTES = 20;
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileOn() {
  return Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}

// Vercel sets x-forwarded-for to the visitor's address (it overwrites
// whatever the visitor sent), so its first entry can be trusted here.
export function clientIp(request) {
  const fwd = request.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
}

const hits = new Map(); // "bucket:ip" -> recent request times
export function rateLimited(bucket, request, max, windowMinutes) {
  const key = bucket + ':' + clientIp(request);
  const now = Date.now(), since = now - windowMinutes * 60_000;
  const recent = (hits.get(key) || []).filter((t) => t > since);
  if (recent.length >= max) { hits.set(key, recent); return true; }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) { // forget the oldest addresses; this is only a burst guard
    for (const k of hits.keys()) { hits.delete(k); if (hits.size <= 4000) break; }
  }
  return false;
}

export const tooMany = () => Response.json({ error: 'Too many requests. Wait a few minutes and try again.' }, { status: 429 });

// Asks Cloudflare whether the token is a real, unused Turnstile solve made
// for the quote form.
export async function checkTurnstile(token, request) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: clientIp(request) });
  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(10_000) });
    const out = await res.json();
    if (!out.success) console.warn('Turnstile said no:', (out['error-codes'] || []).join(', '));
    return out.success === true && (!out.action || out.action === 'quote');
  } catch (err) {
    console.error('Turnstile check failed:', err);
    return false;
  }
}

// The pass is "<expiry ms>.<signature>", signed with a key derived from
// ORDERS_KEY (ORDERS_KEY itself is never used for anything but orders).
function signingKey() {
  return crypto.createHmac('sha256', process.env.ORDERS_KEY || '').update('crackbotics human pass v1').digest();
}
const sign = (exp) => crypto.createHmac('sha256', signingKey()).update(String(exp)).digest('base64url');

export function makePass() {
  const exp = Date.now() + PASS_MINUTES * 60_000;
  return exp + '.' + sign(exp);
}

// True when protection is off, or the pass is ours and still in date.
export function passOk(pass) {
  if (!turnstileOn()) return true;
  if (typeof pass !== 'string' || !/^\d{13}\.[A-Za-z0-9_-]{43}$/.test(pass)) return false;
  const [exp, sig] = pass.split('.');
  if (Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign(exp)), got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
