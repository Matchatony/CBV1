import crypto from 'node:crypto';
import { readDoc, writeDoc } from './orders.js';

// Discount codes, made in the admin panel (api/discounts.js) and checked by the
// quote form (api/discount.js) and again when the order comes in
// (api/order.js). A code takes a percent or a dollar amount off the parts
// (never delivery), and can have an end date and a use limit.
//
// A "once" code works once per customer, without accounts: when an order uses
// it, the customer's email (lowercased, Gmail dots and +tags removed), team
// number and device id (a random id the browser keeps) are remembered as
// one-way hashes, and any later order matching one of them is refused. Once
// codes need a team number. The shop's own emails (SHOP_EMAILS) are never
// limited and never remembered.

// Codes the site's own links rely on. Each is added to the store once (then
// it's an ordinary code: edit it, turn it off or delete it in the admin panel).
const BUILTIN = [
  { code: 'FIRST5', kind: 'percent', value: 5, once: true, note: 'The crackbotics.com/discountFirst link' }
];

export const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
export const normalizeCode = (s) => (typeof s === 'string' ? s.trim().toUpperCase() : '');

// Today in San Diego, as YYYY-MM-DD: a code that ends on a date works all of that day there.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

export async function readCodes() {
  const doc = (await readDoc('discounts')) || {};
  const codes = Array.isArray(doc.codes) ? doc.codes : [];
  const seeded = Array.isArray(doc.seeded) ? doc.seeded : [];
  const add = BUILTIN.filter((b) => !seeded.includes(b.code) && !codes.some((c) => c.code === b.code));
  if (BUILTIN.some((b) => !seeded.includes(b.code))) {
    add.forEach((b) => codes.push({ ...b, active: true, uses: 0, max_uses: 0, expires: '', created: new Date().toISOString() }));
    await saveCodes(codes).catch((err) => console.error('Adding the built-in codes failed:', err));
  }
  return codes;
}
// Every save happens after a read, which seeded the built-in codes.
export const saveCodes = (codes) => writeDoc('discounts', { codes, seeded: BUILTIN.map((b) => b.code) });

// What the admin panel sees: no hashes, just how many customers used a once code.
export const forAdmin = (codes) => codes.map(({ redeemed, ...c }) => c);

export function describe(c) {
  return c.kind === 'percent' ? c.value + '% off' : '$' + (Number.isInteger(c.value) ? c.value : c.value.toFixed(2)) + ' off';
}

// Why a code can't be used right now, or '' if it can.
export function problem(c) {
  if (!c) return 'unknown';
  if (!c.active) return 'inactive';
  if (c.expires && c.expires < today()) return 'expired';
  if (c.max_uses && (c.uses || 0) >= c.max_uses) return 'used_up';
  return '';
}

export const MESSAGES = {
  used_before: 'This code is one per team, and your team, email or device has used it already.',
  needs_team: 'This code is one per team: add your team number above.',
  unknown: 'That code isn\'t valid.',
  inactive: 'That code isn\'t active right now.',
  expired: 'That code has expired.',
  used_up: 'That code has been used up.'
};

// What the customer and the order see of a code: never its use count or note.
export const publicView = (c) => ({ code: c.code, kind: c.kind, value: c.value, label: describe(c),
  ...(c.once ? { once: true } : {}), ...(c.expires ? { expires: c.expires } : {}) });

// ---- Once per customer ----
export function normalizeEmail(e) {
  const [local = '', domain = ''] = String(e || '').trim().toLowerCase().split('@');
  if (!domain) return '';
  let name = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') return name.replace(/\./g, '') + '@gmail.com';
  return name + '@' + domain;
}
const teamNumber = (t) => { const d = String(t || '').replace(/\D/g, ''); return d ? String(Number(d)) : ''; };
const SHOP = () => (process.env.SHOP_EMAILS || 'anthonyhuynh980@gmail.com,crackboticssandiego@gmail.com').split(',').map(normalizeEmail).filter(Boolean);
export const isShop = (email) => SHOP().includes(normalizeEmail(email));

function hash(s) {
  const key = crypto.createHmac('sha256', process.env.ORDERS_KEY || '').update('crackbotics customer id v1').digest();
  return crypto.createHmac('sha256', key).update(s).digest('base64url').slice(0, 22);
}
// The one-way ids a customer is known by: { email, team, device } → hashes.
export function customerIds({ email, team, device }) {
  const ids = [];
  const e = normalizeEmail(email), t = teamNumber(team);
  if (e) ids.push(hash('e:' + e));
  if (t) ids.push(hash('t:' + t));
  if (typeof device === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(device)) ids.push(hash('d:' + device));
  return ids;
}

// Why this customer can't use a once code, or ''. Pass final: true when the
// order is being sent (the team number is required then).
export function customerProblem(c, who, { final } = {}) {
  if (!c || !c.once || isShop(who.email)) return '';
  if (final && !teamNumber(who.team)) return 'needs_team';
  const ids = customerIds(who);
  return ids.some((id) => (c.redeemed || []).includes(id)) ? 'used_before' : '';
}

// Remembers a customer on a once code (call after a successful check).
export function remember(c, who) {
  if (!c.once || isShop(who.email)) return false;
  const have = new Set(c.redeemed || []);
  customerIds(who).forEach((id) => have.add(id));
  c.redeemed = [...have].slice(-30000);
  c.customers = (c.customers || 0) + 1;
  return true;
}

// Checks and fills in a code from the admin form. Returns { code } or { error }.
export function cleanCode(body, existing) {
  const out = { ...(existing || {}) };
  if (!existing) {
    out.code = normalizeCode(body.code);
    if (!CODE_RE.test(out.code)) return { error: 'Codes are 3 to 24 letters, digits, - or _.' };
    out.uses = 0;
    out.active = true;
    out.created = new Date().toISOString();
  }
  if (body.kind !== undefined) {
    if (!['percent', 'amount'].includes(body.kind)) return { error: 'Pick percent or dollars off.' };
    out.kind = body.kind;
  }
  if (body.value !== undefined) out.value = Number(body.value);
  if (!Number.isFinite(out.value) || out.value <= 0) return { error: 'The discount has to be more than 0.' };
  if (out.kind === 'percent' && out.value > 100) return { error: 'A percent discount can be at most 100%.' };
  if (out.kind === 'amount' && out.value > 10000) return { error: 'That dollar amount is too big.' };
  out.value = Math.round(out.value * 100) / 100;
  if (body.expires !== undefined) {
    const d = String(body.expires || '');
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: 'End date must be a date.' };
    out.expires = d;
  }
  if (body.max_uses !== undefined) {
    const n = Number(body.max_uses || 0);
    if (!Number.isInteger(n) || n < 0 || n > 100000) return { error: 'Use limit must be a whole number (0 for no limit).' };
    out.max_uses = n;
  }
  if (body.note !== undefined) out.note = String(body.note || '').trim().slice(0, 200);
  if (body.active !== undefined) out.active = body.active === true;
  if (body.once !== undefined) out.once = body.once === true;
  if (!out.kind) return { error: 'Pick percent or dollars off.' };
  return { code: out };
}
