import nodemailer from 'nodemailer';

// The email a customer gets right after sending a quote request: their order
// number, the estimate, how it gets to them, a link to the status page and
// what happens next. Sent through Gmail as GMAIL_USER (default
// crackboticssandiego@gmail.com), signed in with GMAIL_APP_PASSWORD, a Google
// app password (see README). Off until that password is set.
//
// Anyone can type any email into the quote form, so this only ever contains
// text the site wrote (plus the customer's first name, letters only): nothing
// else they typed, no file names, no notes. That keeps the form from being a
// way to mail spam to strangers. Each address also gets at most 3 a day.

const SITE = 'https://crackbotics.com';
const FROM = () => process.env.GMAIL_USER || 'crackboticssandiego@gmail.com';
export const confirmOn = () => Boolean(process.env.GMAIL_APP_PASSWORD);

const sentTo = new Map(); // address -> send times today (this instance)
function overLimit(address) {
  const day = Date.now() - 24 * 3600_000;
  const recent = (sentTo.get(address) || []).filter((t) => t > day);
  if (recent.length >= 3) return true;
  recent.push(Date.now());
  sentTo.set(address, recent);
  return false;
}

const money = (n) => '$' + n.toFixed(2).replace(/\.00$/, '');
const firstName = (name) => (String(name || '').trim().split(/\s+/)[0] || '').replace(/[^\p{L}'-]/gu, '').slice(0, 24) || 'there';

// The estimate line, from the numbers the order was saved with (never the
// free-text price field).
function estimate(o) {
  const p = o.specs && o.specs.price;
  if (o.escalated || !p || !(p.total > 0)) return 'We\'ll price this one by hand and email you the full price.';
  const extras = [p.partial ? 'the files we price by hand' : '', o.delivery === 'ship' && !p.delivery ? 'shipping' : ''].filter(Boolean);
  return money(p.total) + (extras.length ? ', plus ' + extras.join(' and ') + ', which we\'ll email you' : '') + '.';
}
function handoff(o) {
  const box = o.specs && o.specs.shipping_box;
  if (o.delivery === 'ship') return 'Shipped by USPS Priority Mail' + (box ? ' (' + box + ')' : '') + ' to the address you gave.';
  if (o.delivery === 'delivery') return 'Local delivery in San Diego, to the address you gave.';
  return 'Pickup in San Diego. We\'ll email you when it\'s ready.';
}

export function confirmationEmail(o) {
  const link = SITE + '/status.html?order=' + encodeURIComponent(o.id) + '&email=' + encodeURIComponent(o.email);
  const files = Array.isArray(o.files) ? o.files.length : 1;
  const rows = [
    ['Order number', o.id],
    ['Estimate', estimate(o)],
    ['Files', files + (files === 1 ? ' file' : ' files')],
    ['Getting it to you', handoff(o)]
  ];
  const next = 'Nothing to pay yet. We\'ll check your files and confirm the price by email, usually the same day, ' +
    'then send payment details (Venmo, Cash App or PayPal). Questions? Just reply to this email.';
  const text = `Hi ${firstName(o.name)},\n\nThanks for your quote request. We've got it.\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\nTrack your order: ${link}\n\n${next}\n\n— Crackbotics\n${SITE}\n`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<!doctype html><html><body style="margin:0;background:#f4f2f6;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#14121a">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3dfe8;padding:28px">
<p style="margin:0 0 18px;font-size:22px;font-weight:bold"><span style="color:#d4789f">crack</span>botics</p>
<p style="margin:0 0 14px;font-size:16px">Hi ${esc(firstName(o.name))},</p>
<p style="margin:0 0 18px;font-size:16px">Thanks for your quote request. We've got it.</p>
<table style="border-collapse:collapse;width:100%;font-size:15px;margin:0 0 20px">${rows.map(([k, v]) =>
    `<tr><td style="padding:8px 12px 8px 0;color:#6b6475;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:8px 0;border-bottom:1px solid #eee">${esc(v)}</td></tr>`).join('')}</table>
<p style="margin:0 0 20px"><a href="${esc(link)}" style="display:inline-block;background:#e9a8c9;color:#14121a;text-decoration:none;font-weight:bold;padding:12px 18px">Track your order</a></p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.5">${esc(next)}</p>
<p style="margin:0;font-size:14px;color:#6b6475">— Crackbotics · <a href="${SITE}" style="color:#b0577f">crackbotics.com</a></p>
</div></body></html>`;
  return { subject: `We got your quote request (order ${o.id.split('-')[0]}) — Crackbotics`, text, html };
}

// Sends it; returns true if it went. Never throws.
export async function sendConfirmation(o) {
  if (!confirmOn() || !o || !o.email) return false;
  if (overLimit(o.email.trim().toLowerCase())) { console.warn('Confirmation skipped: daily limit for this address'); return false; }
  const port = Number(process.env.SMTP_PORT) || 465;
  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com', // overridable for testing
      port,
      secure: port === 465,
      auth: { user: FROM(), pass: process.env.GMAIL_APP_PASSWORD },
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000
    });
    const mail = confirmationEmail(o);
    await transport.sendMail({ from: `Crackbotics <${FROM()}>`, to: o.email, replyTo: FROM(), ...mail });
    return true;
  } catch (err) {
    console.error('Confirmation email failed:', err.message);
    return false;
  }
}
