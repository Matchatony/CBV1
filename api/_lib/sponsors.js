import { recordStore } from './orders.js';

// Sponsored Team Program applications (sponsor.html → api/sponsor.js; reviewed in
// admin.html → api/sponsors.js). Stored encrypted under sponsors/ like orders.
export const applications = recordStore('sponsors/');
export const APP_STATUSES = ['new', 'reviewing', 'accepted', 'declined'];

// The form's fields: name → [label (for the email and admin panel), max length, required].
export const FIELDS = {
  team_number: ['Team number', 8, true],
  team_name: ['Team name', 120, true],
  location: ['City and state', 120, true],
  contact_name: ['Contact name', 120, true],
  contact_email: ['Contact email', 200, true],
  role: ['Role on the team', 40, true],
  mentor_email: ['Coach or mentor email', 200, false],
  results: ['Competition results', 2000, true],
  community: ['Community involvement', 2000, true],
  sharing: ['How the team shares its work', 2000, true],
  links: ['Links', 1000, false],
  why: ['Why CrackBotics', 2000, true],
  parts: ['Parts needed this season', 1000, false]
};
export const ROLES = ['Student', 'Coach or mentor', 'Parent'];

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Returns { app } with only known, trimmed, length-capped fields, or { error }.
export function cleanApplication(body) {
  const app = {};
  for (const [k, [label, max, required]] of Object.entries(FIELDS)) {
    const v = typeof body[k] === 'string' ? body[k].trim().slice(0, max) : '';
    if (required && !v) return { error: label + ' is required.' };
    app[k] = v;
  }
  app.team_number = app.team_number.replace(/\D/g, '');
  if (!app.team_number) return { error: 'Team number should be digits, like 21239.' };
  if (!EMAIL.test(app.contact_email)) return { error: 'Contact email doesn\'t look right.' };
  if (app.mentor_email && !EMAIL.test(app.mentor_email)) return { error: 'Coach or mentor email doesn\'t look right.' };
  if (!ROLES.includes(app.role)) return { error: 'Pick your role on the team.' };
  return { app };
}
