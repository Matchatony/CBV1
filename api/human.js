import { turnstileOn, checkTurnstile, makePass, rateLimited, tooMany } from './_lib/guard.js';
import { suggestAddresses } from './_lib/address.js';

// The quote form's helpers.
// GET: the Turnstile site key the quote form should use (null while bot
// protection is off). POST { token }: checks a Turnstile solve with Cloudflare
// and returns a pass the form shows when it uploads files and sends the order.
// Also /api/address (rewritten here in vercel.json, to stay within the Hobby
// plan's 12 functions): GET ?q= or POST { q } → address suggestions, see
// _lib/address.js.
export function GET(request) {
  const q = new URL(request.url).searchParams.get('q');
  if (q !== null) return suggestAddresses(request, q);
  return Response.json({ siteKey: turnstileOn() ? process.env.TURNSTILE_SITE_KEY : null },
    { headers: { 'cache-control': 'public, max-age=300' } });
}

export async function POST(request) {
  let body = null;
  try { body = await request.json(); } catch { /* answered below */ }
  if (body && typeof body === 'object' && 'q' in body) return suggestAddresses(request, body.q);
  if (!turnstileOn()) return Response.json({ pass: null });
  if (rateLimited('human', request, 20, 10)) return tooMany();
  if (!body) return Response.json({ error: 'Invalid request' }, { status: 400 });
  if (!(await checkTurnstile(body.token, request))) {
    return Response.json({ error: 'Could not confirm you are human' }, { status: 403 });
  }
  return Response.json({ pass: makePass() });
}
