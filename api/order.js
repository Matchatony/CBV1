import { newId, saveOrder } from './_lib/orders.js';

// Called by the quote form alongside the FormSubmit email, so every request
// also lands in the admin order log. Anyone can call it, so everything is
// size-capped and type-checked; the email remains the primary record.
const LIMITS = { name: 120, team: 20, email: 200, part_type: 60, details: 4000, address: 300,
  quote_summary: 6000, price: 60, part: 400, design_file: 600, file_name: 200 };

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export async function POST(request) {
  const raw = await request.text();
  if (raw.length > 32_000) return Response.json({ error: 'Too large' }, { status: 413 });
  let body;
  try { body = JSON.parse(raw); } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Invalid request' }, { status: 400 });
  if (body._honey) return Response.json({ ok: true });

  const order = { id: newId(), createdAt: new Date().toISOString(), status: 'new', notes: '' };
  for (const [field, max] of Object.entries(LIMITS)) order[field] = clip(body[field], max);
  order.delivery = body.delivery === 'delivery' ? 'delivery' : 'pickup';
  order.escalated = body.escalated === true;
  if (!order.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(order.email)) {
    return Response.json({ error: 'Name and a valid email are required' }, { status: 400 });
  }
  if (order.design_file && !/^(https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/|UPLOAD FAILED)/.test(order.design_file)) {
    order.design_file = '';
  }
  try {
    await saveOrder(order);
  } catch (err) {
    console.error('Saving order failed:', err);
    return Response.json({ error: 'Could not save' }, { status: 500 });
  }
  return Response.json({ ok: true, id: order.id });
}
