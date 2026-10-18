import { STATUSES } from './orders.js';

// The rules for editing an order, shared by the admin API (api/orders.js PATCH)
// and the Claude connector (api/mcp/[key].js) so both accept and refuse exactly
// the same things. Only the fields present in `body` are checked and returned.
// Returns { changes } or { error } (the message the admin panel shows).
export function orderChanges(body) {
  const changes = {};
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return { error: 'Bad status' };
    changes.status = body.status;
  }
  if (body.notes !== undefined) changes.notes = String(body.notes).slice(0, 4000);
  // Delivery planning (the Deliveries tab): day, time window, stop order, address fixes.
  if (body.delivery_date !== undefined) {
    const d = String(body.delivery_date);
    // Round-trip check so impossible days like 2026-02-30 are refused, not rolled over.
    const real = /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
    if (d && !real) return { error: 'Bad date' };
    changes.delivery_date = d;
  }
  if (body.delivery_window !== undefined) changes.delivery_window = String(body.delivery_window).trim().slice(0, 40);
  if (body.delivery_stop !== undefined) {
    const n = Number(body.delivery_stop);
    if (!Number.isInteger(n) || n < 0 || n > 999) return { error: 'Bad stop number' };
    changes.delivery_stop = n;
  }
  if (body.address !== undefined) changes.address = String(body.address).trim().slice(0, 300);
  // The carrier's tracking number for a shipped order, shown on the customer's status page.
  if (body.tracking !== undefined) changes.tracking = String(body.tracking).replace(/[^A-Za-z0-9 -]/g, '').trim().slice(0, 40);
  // Map position for the delivery map: { q: the address it was looked up for, lat, lon },
  // with lat/lon null when the lookup found nothing (so it isn't retried every load).
  if (body.geo !== undefined) {
    const g = body.geo;
    if (!g || typeof g !== 'object') return { error: 'Bad map position' };
    const q = String(g.q || '').slice(0, 300);
    if (g.lat === null && g.lon === null) {
      changes.geo = { q, lat: null, lon: null };
    } else {
      const { lat, lon } = g;
      if (!(typeof lat === 'number' && typeof lon === 'number' && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return { error: 'Bad map position' };
      changes.geo = { q, lat, lon };
    }
  }
  if (body.delivered !== undefined) changes.delivered_at = body.delivered === true ? new Date().toISOString() : '';
  return { changes };
}
