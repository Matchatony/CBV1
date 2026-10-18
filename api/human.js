import { turnstileOn, checkTurnstile, makePass, rateLimited, tooMany } from './_lib/guard.js';

// GET: the Turnstile site key the quote form should use (null while bot
// protection is off). POST { token }: checks a Turnstile solve with Cloudflare
// and returns a pass the form shows when it uploads files and sends the order.
export function GET() {
  return Response.json({ siteKey: turnstileOn() ? process.env.TURNSTILE_SITE_KEY : null },
    { headers: { 'cache-control': 'public, max-age=300' } });
}

export async function POST(request) {
  if (!turnstileOn()) return Response.json({ pass: null });
  if (rateLimited('human', request, 20, 10)) return tooMany();
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  if (!(await checkTurnstile(body && body.token, request))) {
    return Response.json({ error: 'Could not confirm you are human' }, { status: 403 });
  }
  return Response.json({ pass: makePass() });
}
