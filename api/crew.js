import crypto from 'node:crypto';
import { adminGate, readDoc, writeDoc } from './_lib/orders.js';

// The shop crew's photos at the top of admin.html: only for a signed-in admin
// (ADMIN_PASSWORD as a Bearer token). They're kept encrypted next to the
// orders (settings/crew/ in the Blob store), never in the site's files or its
// public repository, so nobody sees them without the password.
// GET lists them; POST { data, caption } adds one (data: a JPEG, PNG or WebP
// data URL, already shrunk by the page); DELETE { id } removes one.

const noStore = { 'cache-control': 'no-store' };
const fail = (error, status = 400) => Response.json({ error }, { status, headers: noStore });
const MAX_PHOTOS = 12;
const MAX_BYTES = 1_500_000;
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

async function photos() {
  const doc = await readDoc('crew');
  return (doc && Array.isArray(doc.photos)) ? doc.photos : [];
}
const reply = (list) => Response.json({ photos: list }, { headers: noStore });

export async function GET(request) {
  const refused = await adminGate(request);
  if (refused) return refused;
  return reply(await photos());
}

export async function POST(request) {
  const refused = await adminGate(request);
  if (refused) return refused;
  const raw = await request.text();
  if (raw.length > 2.2 * MAX_BYTES) return fail('That photo is too big.', 413);
  let body;
  try { body = JSON.parse(raw); } catch { return fail('Invalid request'); }
  const m = DATA_URL.exec((body && body.data) || '');
  if (!m) return fail('Send a JPEG, PNG or WebP photo.');
  if (Buffer.from(m[2], 'base64').length > MAX_BYTES) return fail('That photo is too big.', 413);
  const list = await photos();
  if (list.length >= MAX_PHOTOS) return fail(`There are already ${MAX_PHOTOS} photos: remove one first.`);
  const caption = typeof body.caption === 'string' ? body.caption.trim().slice(0, 80) : '';
  const next = [...list, { id: crypto.randomBytes(8).toString('hex'), src: body.data, caption, at: new Date().toISOString() }];
  await writeDoc('crew', { photos: next });
  return reply(next);
}

export async function DELETE(request) {
  const refused = await adminGate(request);
  if (refused) return refused;
  let body;
  try { body = await request.json(); } catch { return fail('Invalid request'); }
  const list = await photos();
  const next = list.filter((p) => p.id !== (body && body.id));
  if (next.length === list.length) return fail('No such photo.', 404);
  await writeDoc('crew', { photos: next });
  return reply(next);
}
