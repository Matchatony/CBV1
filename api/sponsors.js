import { adminGate, isValidId } from './_lib/orders.js';
import { applications, APP_STATUSES } from './_lib/sponsors.js';

// Admin API for Sponsored Team Program applications (admin.html → Sponsors).
// Every method needs ADMIN_PASSWORD as a Bearer token. GET lists them; PATCH
// { id, status?, notes? } updates one; DELETE { id } removes one.
const noStore = { 'cache-control': 'no-store' };
const bad = (error, status = 400) => Response.json({ error }, { status });
async function body(request) {
  try { const b = await request.json(); return b && typeof b === 'object' ? b : null; } catch { return null; }
}

export async function GET(request) {
  const refused = await adminGate(request);
  if (refused) return refused;
  try {
    return Response.json({ applications: await applications.list(), statuses: APP_STATUSES }, { headers: noStore });
  } catch (err) {
    console.error('Listing applications failed:', err);
    return bad('Could not load the applications', 500);
  }
}

export async function PATCH(request) {
  const refused = await adminGate(request);
  if (refused) return refused;
  const b = await body(request);
  if (!b || !isValidId(b.id)) return bad('Bad id');
  const changes = {};
  if (b.status !== undefined) {
    if (!APP_STATUSES.includes(b.status)) return bad('Bad status');
    changes.status = b.status;
  }
  if (b.notes !== undefined) changes.notes = String(b.notes).slice(0, 4000);
  if (!Object.keys(changes).length) return bad('Nothing to change');
  const rec = await applications.update(b.id, changes);
  return rec ? Response.json({ application: rec }, { headers: noStore }) : bad('Not found', 404);
}

export async function DELETE(request) {
  const refused = await adminGate(request);
  if (refused) return refused;
  const b = await body(request);
  if (!b || !isValidId(b.id)) return bad('Bad id');
  return (await applications.remove(b.id)) ? Response.json({ ok: true }) : bad('Not found', 404);
}
