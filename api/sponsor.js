import { newId, seenRequest, rememberRequest } from './_lib/orders.js';
import { passOk, rateLimited, tooMany } from './_lib/guard.js';
import { sendMail, MAIL_CC } from './_lib/mail.js';
import { applications, cleanApplication, FIELDS, applicationsClosed } from './_lib/sponsors.js';

// The Sponsored Team Program application (sponsor.html). Saves it for the
// admin panel's Sponsors tab and emails it to the shop. Same bot protection
// as the quote form: the Turnstile pass (api/human.js), a honeypot, and a
// per-IP limit.
export async function POST(request) {
  if (rateLimited('sponsor', request, 3, 10)) return tooMany();
  const raw = await request.text();
  if (raw.length > 20_000) return Response.json({ error: 'That\'s too long.' }, { status: 413 });
  let body;
  try { body = JSON.parse(raw); } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Invalid request' }, { status: 400 });
  if (body._honey) return Response.json({ ok: true });
  if (applicationsClosed()) return Response.json({ error: 'Applications for the 2026–2027 season are closed.' }, { status: 410 });
  if (!passOk(body.pass)) return Response.json({ error: 'Bot check missing or expired' }, { status: 403 });
  // Sent before (Send pressed again after an unclear error): don't save a second copy.
  if (await seenRequest('sponsor', body.request_id)) return Response.json({ ok: true, saved: true, emailed: true, repeat: true });
  const { app, error } = cleanApplication(body);
  if (error) return Response.json({ error }, { status: 400 });

  const rec = { id: newId(), createdAt: new Date().toISOString(), status: 'new', notes: '', season: '2026–2027', ...app };
  const fields = {};
  for (const [k, [label]] of Object.entries(FIELDS)) if (app[k]) fields[label] = app[k];
  const [saved, emailed] = await Promise.all([
    applications.save(rec).then(() => true, (err) => { console.error('Saving an application failed:', err); return false; }),
    sendMail({
      ...fields,
      email: app.contact_email, // FormSubmit makes this the Reply-To
      _subject: 'Sponsored team application — FTC ' + app.team_number + ' ' + app.team_name,
      _template: 'table',
      ...(MAIL_CC() ? { _cc: MAIL_CC() } : {})
    })
  ]);
  if (!saved && !emailed) return Response.json({ error: 'Couldn\'t send your application. Please try again, or email it to crackboticssandiego@gmail.com.' }, { status: 502 });
  if (saved) await rememberRequest('sponsor', body.request_id, { id: rec.id });
  return Response.json({ ok: true, saved, emailed });
}
