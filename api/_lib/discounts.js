import { readDoc, writeDoc } from './orders.js';

// Discount codes, made in the admin panel (api/discounts.js) and checked by the
// quote form (api/discount.js) and again when the order comes in
// (api/order.js). A code takes a percent or a dollar amount off the parts
// (never delivery), and can have an end date and a use limit.

export const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
export const normalizeCode = (s) => (typeof s === 'string' ? s.trim().toUpperCase() : '');

// Today in San Diego, as YYYY-MM-DD: a code that ends on a date works all of that day there.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

export async function readCodes() {
  const doc = await readDoc('discounts');
  return (doc && Array.isArray(doc.codes)) ? doc.codes : [];
}
export const saveCodes = (codes) => writeDoc('discounts', { codes });

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
  unknown: 'That code isn\'t valid.',
  inactive: 'That code isn\'t active right now.',
  expired: 'That code has expired.',
  used_up: 'That code has been used up.'
};

// What the customer and the order see of a code: never its use count or note.
export const publicView = (c) => ({ code: c.code, kind: c.kind, value: c.value, label: describe(c) });

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
  if (!out.kind) return { error: 'Pick percent or dollars off.' };
  return { code: out };
}
