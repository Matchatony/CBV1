import { readCodes, normalizeCode, problem, customerProblem, publicView, MESSAGES } from './_lib/discounts.js';
import { rateLimited, tooMany } from './_lib/guard.js';

// The quote form's "Apply" button and the discount link's landing page:
// POST { code, email?, team?, device?, final? } → { valid, code, kind, value,
// label, once? } or { valid: false, reason, message }. For a once-per-customer
// code it also says whether this email, team or device has used it (final:
// true, sent just before the order, also requires the team number).
// Rate-limited per IP so codes can't be found by guessing. Making and changing
// codes is api/discounts.js (admin).
export async function POST(request) {
  if (rateLimited('discount', request, 30, 10)) return tooMany();
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  const code = normalizeCode(body && body.code);
  if (!code) return Response.json({ valid: false, message: MESSAGES.unknown });
  try {
    const found = (await readCodes()).find((c) => c.code === code);
    const who = { email: body.email, team: body.team, device: body.device };
    const why = problem(found) || customerProblem(found, who, { final: body.final === true });
    return Response.json(why ? { valid: false, reason: why, message: MESSAGES[why] } : { valid: true, ...publicView(found) },
      { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('Checking a discount code failed:', err);
    return Response.json({ error: 'Could not check the code' }, { status: 500 });
  }
}
