import { readCodes, normalizeCode, problem, publicView, MESSAGES } from './_lib/discounts.js';
import { rateLimited, tooMany } from './_lib/guard.js';

// The quote form's "Apply" button: POST { code } → { valid, code, kind, value, label }
// or { valid: false, message }. Rate-limited per IP so codes can't be guessed
// by trying them all. Making and changing codes is api/discounts.js (admin).
export async function POST(request) {
  if (rateLimited('discount', request, 15, 10)) return tooMany();
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  const code = normalizeCode(body && body.code);
  if (!code) return Response.json({ valid: false, message: MESSAGES.unknown });
  try {
    const found = (await readCodes()).find((c) => c.code === code);
    const why = problem(found);
    return Response.json(why ? { valid: false, message: MESSAGES[why] } : { valid: true, ...publicView(found) },
      { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('Checking a discount code failed:', err);
    return Response.json({ error: 'Could not check the code' }, { status: 500 });
  }
}
