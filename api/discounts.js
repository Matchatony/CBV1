import { isAdmin } from './_lib/orders.js';
import { readCodes, saveCodes, cleanCode, normalizeCode, forAdmin } from './_lib/discounts.js';

// Admin API for discount codes (admin.html → Discounts). Every method needs
// ADMIN_PASSWORD as a Bearer token. GET lists them; POST makes one
// { code, kind: 'percent' | 'amount', value, expires?, max_uses?, note?, once? };
// PATCH { code, ...fields to change, active? } edits one; DELETE { code }.
const denied = () => Response.json({ error: 'Wrong password' }, { status: 401 });
const noStore = { 'cache-control': 'no-store' };
const bad = (error, status = 400) => Response.json({ error }, { status });

async function body(request) {
  try { const b = await request.json(); return b && typeof b === 'object' ? b : null; } catch { return null; }
}

export async function GET(request) {
  if (!(await isAdmin(request))) return denied();
  try {
    return Response.json({ codes: forAdmin(await readCodes()) }, { headers: noStore });
  } catch (err) {
    console.error('Reading discount codes failed:', err);
    return bad('Could not load the codes', 500);
  }
}

export async function POST(request) {
  if (!(await isAdmin(request))) return denied();
  const b = await body(request);
  if (!b) return bad('Invalid request');
  const codes = await readCodes();
  if (codes.some((c) => c.code === normalizeCode(b.code))) return bad('That code already exists.');
  if (codes.length >= 200) return bad('That\'s the most codes the shop can keep; delete some first.');
  const { code, error } = cleanCode(b, null);
  if (error) return bad(error);
  codes.push(code);
  await saveCodes(codes);
  return Response.json({ codes: forAdmin(codes) }, { headers: noStore });
}

export async function PATCH(request) {
  if (!(await isAdmin(request))) return denied();
  const b = await body(request);
  if (!b) return bad('Invalid request');
  const codes = await readCodes();
  const i = codes.findIndex((c) => c.code === normalizeCode(b.code));
  if (i === -1) return bad('No such code', 404);
  const changes = { ...b };
  delete changes.code; delete changes.uses; delete changes.created; delete changes.redeemed; delete changes.customers;
  const { code, error } = cleanCode(changes, codes[i]);
  if (error) return bad(error);
  codes[i] = code;
  await saveCodes(codes);
  return Response.json({ codes: forAdmin(codes) }, { headers: noStore });
}

export async function DELETE(request) {
  if (!(await isAdmin(request))) return denied();
  const b = await body(request);
  if (!b) return bad('Invalid request');
  const codes = await readCodes();
  const left = codes.filter((c) => c.code !== normalizeCode(b.code));
  if (left.length === codes.length) return bad('No such code', 404);
  await saveCodes(left);
  return Response.json({ codes: forAdmin(left) }, { headers: noStore });
}
