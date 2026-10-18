import { isValidId, getOrder } from './_lib/orders.js';
import { rateLimited, tooMany } from './_lib/guard.js';

// The customer's order status page (status.html): GET ?order=<order number>&email=<email>.
// Both have to match, so a guessed order number alone shows nothing. It
// returns only what the customer already knows or needs: where the order is,
// when it's going out, and the tracking number, never notes, files or prices
// beyond what they were quoted. Rate-limited per IP so emails can't be probed.
const LABELS = { new: 'Received', quoted: 'Quoted', paid: 'Paid', 'in-progress': 'Being made', ready: 'Ready', done: 'Done', cancelled: 'Cancelled' };
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const notFound = () => Response.json({ error: 'No order matches that order number and email.' }, { status: 404, headers: { 'cache-control': 'no-store' } });

export async function GET(request) {
  if (rateLimited('status', request, 30, 10)) return tooMany();
  const url = new URL(request.url);
  const id = (url.searchParams.get('order') || '').trim().toLowerCase();
  const email = url.searchParams.get('email') || '';
  if (!isValidId(id) || !email) return notFound();
  let found;
  try { found = await getOrder(id); } catch (err) {
    console.error('Status lookup failed:', err);
    return Response.json({ error: 'Could not look that up right now. Try again in a minute.' }, { status: 500 });
  }
  if (!found || !same(found.order.email, email)) return notFound();
  const o = found.order, sp = o.specs || {};
  return Response.json({
    order: o.id,
    created: o.createdAt,
    status: o.status,
    label: LABELS[o.status] || o.status,
    part_type: o.part_type || '',
    files: Array.isArray(o.files) ? o.files.length : (o.design_file ? 1 : 0),
    price: o.price || '',
    delivery: o.delivery,
    shipping_box: sp.shipping_box || '',
    delivery_date: o.delivery_date || '',
    delivery_window: o.delivery_window || '',
    delivered_at: o.delivered_at || '',
    tracking: o.tracking || ''
  }, { headers: { 'cache-control': 'no-store' } });
}
