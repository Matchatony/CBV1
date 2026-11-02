import { rateLimited, tooMany } from './_lib/guard.js';

// Address suggestions for the quote form's delivery / shipping address field:
// POST { q } → { suggestions: [{ label, exact }] }, at most 5, US only.
//
// Looks the text up with Photon (komoot's OpenStreetMap search, built for
// search-as-you-type, so half-typed words like "4380 Mira" still match), and
// with Nominatim if Photon is down. Done here rather than in the browser so the
// geocoder only ever gets the typed text, never the visitor's IP address, and
// so Nominatim gets the identifying User-Agent its usage policy asks for.
// POST so the text stays out of request logs. Nothing is saved.
//
// Each suggestion is a short mailing-style line ("4380 Miramar Street,
// San Diego, CA 92037"). The house number and unit the customer typed always
// win: a street with no numbers in OpenStreetMap (most US streets) or a
// neighbour's house comes back with the typed number in front, so picking a
// suggestion never drops or changes it. exact is false when the number is the
// typed one rather than a house OpenStreetMap knows.

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const AGENT = 'Crackbotics quote form (https://crackbotics.com)';
const SAN_DIEGO = { lat: 32.7157, lon: -117.1611 }; // local deliveries: nudge ties toward here
const MAX = 5;

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR', guam: 'GU', 'u.s. virgin islands': 'VI', 'united states virgin islands': 'VI',
  'american samoa': 'AS', 'northern mariana islands': 'MP'
};
const stateCode = (name) => (name ? STATES[String(name).toLowerCase()] || String(name) : '');

// What the customer typed: a leading house number ("4380", "4380B",
// "1234-36", "12 1/2") and a unit ("Apt 5", "Unit B", "Suite 200", "#12").
export function typedParts(q) {
  const num = /^\s*(\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?(?:\s+1\/2)?)(?=\s+\S)/.exec(q);
  const unit = /(?:^|[\s,])((?:apt|apartment|unit|suite|ste|bldg|building|rm|room|fl|floor|lot|spc|space)(?:\.\s*|\s*#\s*|\s+)(?:[A-Za-z]?\d[A-Za-z0-9-]*|[A-Za-z])|#\s*[A-Za-z0-9-]+)\b/i.exec(q);
  return { number: num ? num[1] : '', unit: unit ? unit[1].replace(/\s+/g, ' ').trim() : '' };
}

// One suggestion from the pieces a geocoder gives back, or null if it isn't
// somewhere you could send a package (a town, a state, another country).
export function buildLabel(p, typed) {
  if (p.country && p.country !== 'US') return null;
  // Only street-level results: picking a bare town would wipe out what was typed.
  const road = p.road || '';
  if (!road) return null;
  const place = p.name && p.name !== road && !/^\d/.test(p.name) && !['house', 'street', 'road'].includes(p.kind) ? p.name : '';
  let number = p.number || '', exact = Boolean(number);
  if (typed.number && number !== typed.number) {
    if (place && number) return null; // a school or shop at another number isn't the address being typed
    number = typed.number;
    exact = false;
  }
  const parts = [];
  if (place) parts.push(place);
  parts.push([number, road].filter(Boolean).join(' ') + (typed.unit ? ' ' + typed.unit : ''));
  if (p.city) parts.push(p.city);
  const tail = [stateCode(p.state), p.postcode].filter(Boolean).join(' ');
  if (tail) parts.push(tail);
  return { label: parts.join(', '), exact };
}

function fromPhoton(json) {
  return ((json && json.features) || []).map((f) => {
    const p = f.properties || {};
    return {
      country: p.countrycode ? String(p.countrycode).toUpperCase() : '',
      kind: p.type || '',
      name: p.name || '',
      number: p.housenumber || '',
      road: p.street || (p.type === 'street' ? p.name : '') || '',
      city: p.city || p.locality || p.district || '',
      state: p.state || '',
      postcode: p.postcode || ''
    };
  });
}

function fromNominatim(json) {
  return (Array.isArray(json) ? json : []).map((h) => {
    const a = h.address || {};
    const road = a.road || a.pedestrian || a.footway || a.path || '';
    return {
      country: a.country_code ? String(a.country_code).toUpperCase() : '',
      kind: h.addresstype === 'road' ? 'street' : (h.addresstype || ''),
      name: h.name || '',
      number: a.house_number || '',
      road,
      city: a.city || a.town || a.village || a.hamlet || a.suburb || '',
      state: (a['ISO3166-2-lvl4'] || '').replace(/^US-/, '') || a.state || '',
      postcode: a.postcode || ''
    };
  });
}

async function lookUp(q) {
  const headers = { 'user-agent': AGENT, accept: 'application/json' };
  try {
    const url = PHOTON + '?' + new URLSearchParams({ q, limit: '12', lang: 'en', lat: String(SAN_DIEGO.lat), lon: String(SAN_DIEGO.lon), zoom: '10' });
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    if (res.ok) return fromPhoton(await res.json());
    console.warn('Photon said', res.status);
  } catch (err) {
    console.warn('Photon lookup failed:', err.message);
  }
  const url = NOMINATIM + '?' + new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: '8', countrycodes: 'us' });
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('Nominatim said ' + res.status);
  return fromNominatim(await res.json());
}

export async function POST(request) {
  if (rateLimited('address', request, 150, 10)) return tooMany();
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  const q = typeof (body && body.q) === 'string' ? body.q.replace(/\s+/g, ' ').trim() : '';
  if (q.length < 3 || q.length > 200) return Response.json({ error: 'Type 3 to 200 characters.' }, { status: 400 });
  const typed = typedParts(q);
  try {
    const seen = new Map(), suggestions = []; // the same line twice (neighbours given the typed number) shows once
    for (const p of await lookUp(q)) {
      const s = buildLabel(p, typed);
      if (!s) continue;
      const key = s.label.toLowerCase();
      if (seen.has(key)) { if (s.exact) seen.get(key).exact = true; continue; }
      if (suggestions.length === MAX) continue;
      seen.set(key, s);
      suggestions.push(s);
    }
    return Response.json({ suggestions }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('Address lookup failed:', err.message);
    return Response.json({ suggestions: [], error: 'lookup failed' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
