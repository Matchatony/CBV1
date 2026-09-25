import crypto from 'node:crypto';
import { put, list, del } from '@vercel/blob';

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

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

function decrypt(text) {
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

export async function updateOrder(id, changes) {
  const found = await getOrder(id);
  if (!found) return null;
  const order = { ...found.order, ...changes, updatedAt: new Date().toISOString() };
  await saveOrder(order);
  await del(found.versions);
  return order;
}

export async function deleteOrder(id, { withFile }) {
  const found = await getOrder(id);
  if (!found) return false;
  const urls = [...found.versions];
  const file = found.order.design_file || '';
  if (withFile && /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/quotes\//.test(file)) urls.push(file);
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
