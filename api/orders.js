import { STATUSES, isAdmin, isValidId, listOrders, updateOrder, deleteOrder } from './_lib/orders.js';

// Admin API for admin.html. Every method requires the ADMIN_PASSWORD as a
// Bearer token.
const denied = () => Response.json({ error: 'Wrong password' }, { status: 401 });
const noStore = { 'cache-control': 'no-store' };

export async function GET(request) {
  if (!(await isAdmin(request))) return denied();
  try {
    return Response.json({ orders: await listOrders(), statuses: STATUSES }, { headers: noStore });
  } catch (err) {
    console.error('Listing orders failed:', err);
    return Response.json({ error: 'Could not load orders' }, { status: 500 });
  }
}

export async function PATCH(request) {
  if (!(await isAdmin(request))) return denied();
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  if (!isValidId(body.id)) return Response.json({ error: 'Bad id' }, { status: 400 });
  const changes = {};
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return Response.json({ error: 'Bad status' }, { status: 400 });
    changes.status = body.status;
  }
  if (body.notes !== undefined) changes.notes = String(body.notes).slice(0, 4000);
  const order = await updateOrder(body.id, changes);
  return order ? Response.json({ order }, { headers: noStore }) : Response.json({ error: 'Not found' }, { status: 404 });
}

export async function DELETE(request) {
  if (!(await isAdmin(request))) return denied();
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  if (!isValidId(body.id)) return Response.json({ error: 'Bad id' }, { status: 400 });
  const ok = await deleteOrder(body.id, { withFile: body.withFile === true });
  return ok ? Response.json({ ok: true }) : Response.json({ error: 'Not found' }, { status: 404 });
}
