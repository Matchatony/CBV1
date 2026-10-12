import { STATUSES, isAdmin, isValidId, listOrders, updateOrder, deleteOrder } from './_lib/orders.js';
import { orderChanges } from './_lib/changes.js';

// Admin API for admin.html. Every method requires the ADMIN_PASSWORD as a
// Bearer token.
const denied = () => Response.json({ error: 'Wrong password' }, { status: 401 });
const noStore = { 'cache-control': 'no-store' };

// The fab shop's location for the admin map. Kept in env vars (FAB_ADDRESS, and
// optionally FAB_LATLON as "lat,lon") rather than in the public page source.
function fab() {
  const address = (process.env.FAB_ADDRESS || '').trim();
  if (!address) return null;
  const parts = (process.env.FAB_LATLON || '').split(',').map((x) => x.trim());
  const lat = parts[0] ? Number(parts[0]) : NaN, lon = parts[1] ? Number(parts[1]) : NaN;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { address, lat, lon } : { address };
}

export async function GET(request) {
  if (!(await isAdmin(request))) return denied();
  try {
    return Response.json({ orders: await listOrders(), statuses: STATUSES, fab: fab() }, { headers: noStore });
  } catch (err) {
    console.error('Listing orders failed:', err);
    return Response.json({ error: 'Could not load orders' }, { status: 500 });
  }
}

export async function PATCH(request) {
  if (!(await isAdmin(request))) return denied();
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  if (!body || !isValidId(body.id)) return Response.json({ error: 'Bad id' }, { status: 400 });
  const { changes, error } = orderChanges(body);
  if (error) return Response.json({ error }, { status: 400 });
  const order = await updateOrder(body.id, changes);
  return order ? Response.json({ order }, { headers: noStore }) : Response.json({ error: 'Not found' }, { status: 404 });
}

export async function DELETE(request) {
  if (!(await isAdmin(request))) return denied();
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  if (!body || !isValidId(body.id)) return Response.json({ error: 'Bad id' }, { status: 400 });
  const ok = await deleteOrder(body.id, { withFile: body.withFile === true });
  return ok ? Response.json({ ok: true }) : Response.json({ error: 'Not found' }, { status: 404 });
}
