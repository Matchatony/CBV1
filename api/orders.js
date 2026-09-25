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
  if (!body || !isValidId(body.id)) return Response.json({ error: 'Bad id' }, { status: 400 });
  const changes = {};
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return Response.json({ error: 'Bad status' }, { status: 400 });
    changes.status = body.status;
  }
  if (body.notes !== undefined) changes.notes = String(body.notes).slice(0, 4000);
  // Delivery planning (the Deliveries tab): day, time window, stop order, address fixes.
  if (body.delivery_date !== undefined) {
    const d = String(body.delivery_date);
    // Round-trip check so impossible days like 2026-02-30 are refused, not rolled over.
    const real = /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
    if (d && !real) return Response.json({ error: 'Bad date' }, { status: 400 });
    changes.delivery_date = d;
  }
  if (body.delivery_window !== undefined) changes.delivery_window = String(body.delivery_window).trim().slice(0, 40);
  if (body.delivery_stop !== undefined) {
    const n = Number(body.delivery_stop);
    if (!Number.isInteger(n) || n < 0 || n > 999) return Response.json({ error: 'Bad stop number' }, { status: 400 });
    changes.delivery_stop = n;
  }
  if (body.address !== undefined) changes.address = String(body.address).trim().slice(0, 300);
  // Map position for the delivery map: { q: the address it was looked up for, lat, lon },
  // with lat/lon null when the lookup found nothing (so it isn't retried every load).
  if (body.geo !== undefined) {
    const g = body.geo;
    if (!g || typeof g !== 'object') return Response.json({ error: 'Bad map position' }, { status: 400 });
    const q = String(g.q || '').slice(0, 300);
    if (g.lat === null && g.lon === null) {
      changes.geo = { q, lat: null, lon: null };
    } else {
      const { lat, lon } = g;
      if (!(typeof lat === 'number' && typeof lon === 'number' && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return Response.json({ error: 'Bad map position' }, { status: 400 });
      changes.geo = { q, lat, lon };
    }
  }
  if (body.delivered !== undefined) changes.delivered_at = body.delivered === true ? new Date().toISOString() : '';
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
