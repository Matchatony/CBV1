// Email to the shop through FormSubmit's AJAX endpoint, sent from the server
// (api/order.js for quote requests, api/sponsor.js for sponsorship
// applications), so the FormSubmit address isn't in any page.
//
// Where it goes: FORMSUBMIT_TO can be the random-string alias FormSubmit offers
// after activation, to keep the real address private. FormSubmit activates a
// form per website, so the request names crackbotics.com as its origin
// (activated already).
export const MAIL_TO = () => process.env.FORMSUBMIT_TO || 'anthonyhuynh980@gmail.com';
export const MAIL_CC = () => process.env.FORMSUBMIT_CC ?? 'crackboticssandiego@gmail.com';
const MAIL_SITE = () => process.env.FORMSUBMIT_SITE || 'https://crackbotics.com';
export const formsubmitUrl = () => 'https://formsubmit.co/' + encodeURIComponent(MAIL_TO());

// fields: the email table's rows plus FormSubmit's _subject/_template/_cc.
// Returns true if FormSubmit took it. Never throws.
export async function sendMail(fields) {
  try {
    const res = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(MAIL_TO()), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: MAIL_SITE(), referer: MAIL_SITE() + '/' },
      body: JSON.stringify(fields),
      signal: AbortSignal.timeout(20_000)
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && String(out.success) === 'true') return true;
    console.error('FormSubmit refused the email:', res.status, out.message || '');
  } catch (err) {
    console.error('FormSubmit send failed:', err);
  }
  return false;
}
