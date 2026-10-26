import crypto from 'node:crypto';
import { put, list, del, head } from '@vercel/blob';
import { clientIp } from './guard.js';

// Order records live in the same Blob store as the design files, under
// orders/<id>/<version>.json. The store is public, so every record is
// encrypted (AES-256-GCM, key in ORDERS_KEY) — a leaked URL shows nothing.
// Public blobs are CDN-cached, so an update writes a new version (new URL,
// never stale) and deletes the old one instead of overwriting in place.

export const STATUSES = ['new', 'quoted', 'paid', 'in-progress', 'ready', 'done', 'cancelled'];
const PREFIX = 'orders/';
const ID_RE = /^[a-z0-9]{6,12}-[a-f0-9]{24}$/;

export const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);
export const newId = () => Date.now().toString(36) + '-' + crypto.randomBytes(12).toString('hex');

function key() {
  const k = Buffer.from(process.env.ORDERS_KEY || '', 'base64');
  if (k.length !== 32) throw new Error('ORDERS_KEY must be 32 bytes, base64-encoded');
  return k;
}

export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

export function decrypt(text) {
  const box = JSON.parse(text);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8'));
}

export async function saveOrder(order) {
  const version = String(Date.now()).padStart(15, '0');
  await put(`${PREFIX}${order.id}/${version}.json`, encrypt(order), {
    access: 'public', addRandomSuffix: false, contentType: 'application/json'
  });
}

async function listVersions(prefix) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

// Groups versions by order id; the newest version is the current record.
function latestById(blobs) {
  const byId = new Map();
  for (const b of blobs) {
    const [, id] = b.pathname.split('/');
    if (!isValidId(id)) continue;
    const entry = byId.get(id) || { latest: null, all: [] };
    entry.all.push(b);
    if (!entry.latest || b.pathname > entry.latest.pathname) entry.latest = b;
    byId.set(id, entry);
  }
  return byId;
}

async function readBlob(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not read order ' + url);
  return decrypt(await res.text());
}

export async function listOrders() {
  const byId = latestById(await listVersions(PREFIX));
  const entries = [...byId.values()];
  const orders = [];
  for (let i = 0; i < entries.length; i += 10) {
    const batch = await Promise.all(entries.slice(i, i + 10).map((e) => readBlob(e.latest.url).catch(() => null)));
    orders.push(...batch.filter(Boolean));
  }
  return orders.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getOrder(id) {
  const entry = latestById(await listVersions(`${PREFIX}${id}/`)).get(id);
  if (!entry) return null;
  return { order: await readBlob(entry.latest.url), versions: entry.all.map((b) => b.url) };
}

// With `by` set (the Claude connector passes 'claude'), the edit is also added to
// the order's `activity` history as { at, by, change: { field: { from, to } } },
// so the admin panel can show what changed and what it was before.
const MAX_ACTIVITY = 100;
export async function updateOrder(id, changes, { by } = {}) {
  const found = await getOrder(id);
  if (!found) return null;
  const order = { ...found.order, ...changes, updatedAt: new Date().toISOString() };
  if (by) {
    const change = {};
    for (const [k, to] of Object.entries(changes)) change[k] = { from: found.order[k] ?? null, to };
    order.activity = [...(found.order.activity || []), { at: order.updatedAt, by, change }].slice(-MAX_ACTIVITY);
  }
  await saveOrder(order);
  await del(found.versions);
  return order;
}

export async function deleteOrder(id, { withFile }) {
  const found = await getOrder(id);
  if (!found) return false;
  const urls = [...found.versions];
  if (withFile) {
    // Every design file on the order (older orders only have design_file).
    const files = [found.order.design_file, ...(found.order.files || []).map((f) => f && f.url)];
    for (const file of new Set(files)) {
      if (/^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/quotes\//.test(file || '')) urls.push(file);
    }
  }
  await del(urls);
  return true;
}

// Admin check: constant-time compare against ADMIN_PASSWORD (hash first so
// the lengths always match), with a small delay on failure to slow guessing.
export async function isAdmin(request) {
  const expected = process.env.ADMIN_PASSWORD || '';
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ok = expected.length >= 12 && crypto.timingSafeEqual(
    crypto.createHash('sha256').update(given).digest(),
    crypto.createHash('sha256').update(expected).digest()
  );
  if (!ok) await new Promise((r) => setTimeout(r, 800));
  return ok;
}

// The admin check every admin endpoint starts with: null when the password is
// right, or the refusal to send back. After 10 wrong passwords from one
// address in 15 minutes, that address is refused (even with the right
// password) until the 15 minutes are up, on top of isAdmin's delay. Like the
// other rate limits it lives in the function's memory, so it slows guessing
// rather than walls it off (the Vercel Firewall is the hard limit, see README).
const adminFails = new Map(); // ip -> times of recent wrong passwords
const FAIL_MAX = 10, FAIL_WINDOW = 15 * 60_000;
export async function adminGate(request) {
  const ip = clientIp(request), now = Date.now();
  const recent = (adminFails.get(ip) || []).filter((t) => t > now - FAIL_WINDOW);
  if (recent.length >= FAIL_MAX) {
    return Response.json({ error: 'Too many wrong passwords from this network. Wait 15 minutes and try again.' },
      { status: 429, headers: { 'retry-after': String(Math.ceil((recent[0] + FAIL_WINDOW - now) / 1000)), 'cache-control': 'no-store' } });
  }
  if (await isAdmin(request)) { adminFails.delete(ip); return null; }
  recent.push(now);
  adminFails.set(ip, recent);
  if (adminFails.size > 5000) for (const k of adminFails.keys()) { adminFails.delete(k); if (adminFails.size <= 4000) break; }
  return Response.json({ error: 'Wrong password' }, { status: 401, headers: { 'cache-control': 'no-store' } });
}

// Small settings records (the discount codes) live next to the orders, under
// settings/<name>/<version>.json, encrypted and versioned the same way.
export async function readDoc(name) {
  const blobs = await listVersions(`settings/${name}/`);
  if (!blobs.length) return null;
  const latest = blobs.reduce((a, b) => (b.pathname > a.pathname ? b : a));
  return readBlob(latest.url);
}

export async function writeDoc(name, doc) {
  const old = await listVersions(`settings/${name}/`);
  const version = String(Date.now()).padStart(15, '0');
  await put(`settings/${name}/${version}.json`, encrypt(doc), {
    access: 'public', addRandomSuffix: false, contentType: 'application/json'
  });
  if (old.length) await del(old.map((b) => b.url));
}

// Other records kept exactly like orders (encrypted, one version per save,
// newest wins), each kind under its own prefix: sponsors/ holds the sponsored
// team applications (api/sponsor.js, api/sponsors.js). Ids come from newId().
export function recordStore(prefix) {
  const save = (rec) => put(`${prefix}${rec.id}/${String(Date.now()).padStart(15, '0')}.json`, encrypt(rec), {
    access: 'public', addRandomSuffix: false, contentType: 'application/json'
  });
  async function get(id) {
    const entry = latestById(await listVersions(`${prefix}${id}/`)).get(id);
    return entry ? { rec: await readBlob(entry.latest.url), versions: entry.all.map((b) => b.url) } : null;
  }
  return {
    save,
    async list() {
      const entries = [...latestById(await listVersions(prefix)).values()];
      const out = [];
      for (let i = 0; i < entries.length; i += 10) {
        out.push(...(await Promise.all(entries.slice(i, i + 10).map((e) => readBlob(e.latest.url).catch(() => null)))).filter(Boolean));
      }
      return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    async update(id, changes) {
      const found = await get(id);
      if (!found) return null;
      const rec = { ...found.rec, ...changes, updatedAt: new Date().toISOString() };
      await save(rec);
      await del(found.versions);
      return rec;
    },
    async remove(id) {
      const found = await get(id);
      if (!found) return false;
      await del(found.versions);
      return true;
    }
  };
}

// Duplicate-send guard. The quote form and the sponsorship form send a random
// request id with each submission and keep it until the send is confirmed, so
// pressing Send again after a timeout or an unclear error resends the same id.
// The first save is remembered under requests/<kind>-<id>.json (just the saved
// record's id, readable only by someone who has the random request id), and a
// repeat gets the first result instead of saving a second copy.
const REQUEST_ID = /^[a-f0-9]{24}$/;
export async function seenRequest(kind, rid) {
  if (!REQUEST_ID.test(rid || '')) return null;
  try {
    const meta = await head(`requests/${kind}-${rid}.json`);
    const res = await fetch(meta.url);
    return res.ok ? await res.json() : null;
  } catch {
    return null; // not seen (or the lookup failed: then a duplicate is possible, never a lost request)
  }
}
export async function rememberRequest(kind, rid, info) {
  if (!REQUEST_ID.test(rid || '')) return;
  await put(`requests/${kind}-${rid}.json`, JSON.stringify({ ...info, at: new Date().toISOString() }), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  }).catch((err) => console.error('Remembering a request id failed:', err));
}
