import crypto from 'node:crypto';
import { put } from '@vercel/blob';
import { isAdmin, isValidId, getOrder, updateOrder } from './_lib/orders.js';
import { downloadDesignFile, isStoreUrl, readStepModel, UserError } from './_lib/step.js';
import { CAM, CamError, stepPart, dxfPart, planSheet, reportText } from './_lib/cam.js';
import { c2dFile } from './_lib/c2d.js';

// Toolpaths for the shop's Shapeoko 5 Pro, for admin.html only (ADMIN_PASSWORD
// as a Bearer token). POST { id, file, part, thickness_mm, qty, climb, save, reuse }:
// file is the order's design file (its index), part the distinct part in it.
// Without save it answers with a preview (picture and report); with save it
// also writes the next version (V1, V2, ...) of the G-code (.nc, for gSender)
// and the Carbide Create project (.c2d), and lists them on the order
// (order.cam); with reuse too, the newest version already made with the same
// settings is handed back instead of a new one. Old versions are never
// replaced or deleted. GET ?id=&i=&kind=nc|c2d downloads version i (its place
// in order.cam) through here, so the admin panel can save it as a file. The files hold
// only the part's shape and the job's settings: their names come from the
// design file's name with the customer's name and email taken out, and
// nothing else about the customer goes in.
//
// The files are kept in the Blob store at an unguessable path, like the design
// files, and only the admin panel links to them.

const noStore = { 'cache-control': 'no-store' };
const fail = (error, status = 400) => Response.json({ error }, { status, headers: noStore });

function filesOf(o) {
  if (Array.isArray(o.files) && o.files.length) return o.files;
  return o.design_file ? [{ name: o.file_name || '', url: o.design_file }] : [];
}
const kindOf = (f) => (/\.dxf$/i.test(f.name || f.url || '') ? 'dxf' : /\.(step|stp)$/i.test(f.name || f.url || '') ? 'step' : null);

// The design file's name as a file name for the toolpaths, without the
// customer's name, email or address in it.
function baseName(fileName, o) {
  const words = new Set([o.name, o.email, o.address].join(' ').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2));
  const nameWords = [...new Set([o.name, (o.email || '').split('@')[0]].join(' ').toLowerCase().split(/[^a-z0-9]+/))].filter((w) => w.length >= 4);
  const tokens = String(fileName || '').replace(/\.[^.]+$/, '').split(/[^A-Za-z0-9]+/).filter(Boolean)
    .filter((t) => !words.has(t.toLowerCase()) && !nameWords.some((w) => t.toLowerCase().includes(w)));
  return tokens.join('_').slice(0, 40) || 'part';
}

// The stock thickness from the order's material ("6061 aluminum, 1/8 in.").
function orderThickness(o) {
  const m = /(\d+)\s*\/\s*(\d+)\s*in/.exec((o.specs && o.specs.material) || '');
  return m && Number(m[2]) ? (Number(m[1]) / Number(m[2])) * 25.4 : null;
}
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// Bump when the toolpath code changes what it makes, so `reuse` stops handing
// back files made by the old code.
const GEN = 2;
// Vercel caps a function's response at 4.5 MB: a bigger file is fetched from
// the store directly.
const MAX_PASS_THROUGH = 4_300_000;
const CAM_URL = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/cam\//;

export async function GET(request) {
  if (!(await isAdmin(request))) return fail('Wrong password', 401);
  const q = new URL(request.url).searchParams;
  const id = q.get('id'), i = Number(q.get('i')), kind = q.get('kind');
  if (!isValidId(id) || !Number.isInteger(i) || !['nc', 'c2d'].includes(kind)) return fail('Bad request');
  const found = await getOrder(id);
  const c = found && Array.isArray(found.order.cam) ? found.order.cam[i] : null;
  if (!c || !CAM_URL.test(c[kind] || '')) return fail('No such toolpath file.', 404);
  const res = await fetch(c[kind], { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return fail(`The file couldn't be read from the store (HTTP ${res.status}).`, 502);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_PASS_THROUGH) return Response.json({ error: 'Too big to pass through here.', url: c[kind] }, { status: 413, headers: noStore });
  return new Response(body, {
    headers: {
      ...noStore,
      'content-type': kind === 'nc' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'content-disposition': `attachment; filename="${c.name.replace(/[^A-Za-z0-9_.-]/g, '_')}.${kind}"`
    }
  });
}

export async function POST(request) {
  if (!(await isAdmin(request))) return fail('Wrong password', 401);
  let body;
  try { body = await request.json(); } catch { return fail('Invalid request'); }
  if (!body || !isValidId(body.id)) return fail('Bad id');
  const found = await getOrder(body.id);
  if (!found) return fail('Not found', 404);
  const o = found.order;
  const files = filesOf(o);
  const index = Number(body.file);
  const f = Number.isInteger(index) ? files[index] : null;
  if (!f) return fail('No such file on this order.');
  const kind = kindOf(f);
  if (!kind) return fail('Toolpaths are made from DXF and STEP files only.');
  if (!isStoreUrl(f.url)) return fail('This file wasn\'t uploaded, so there\'s nothing to make toolpaths from.');

  try {
    const bytes = await downloadDesignFile(f.url);
    const hash = sha(bytes);

    // The distinct parts in the file (a STEP file can hold several).
    let parts, mesh = false;
    if (kind === 'dxf') {
      parts = [{ copies: 1, part: dxfPart(Buffer.from(bytes).toString('latin1')) }];
    } else {
      const read = await readStepModel(bytes, { tol: CAM.chord, profile: true });
      mesh = read.mesh;
      parts = read.model.groups.map((g) => ({ copies: g.copies, m: g.m }));
    }
    const partNo = Math.min(Math.max(1, Number(body.part) || 1), parts.length);
    const chosen = parts[partNo - 1];
    const part = chosen.part || stepPart(chosen.m);
    if (mesh) part.warnings.unshift('This STEP file was read through a mesh (OpenCascade), so curves are followed within about 0.05 mm, not 0.005 mm.');

    // The same file uploaded twice is one part: say so, and count both in the
    // suggested quantity.
    const items = (o.specs && o.specs.items) || [];
    const itemQty = (i) => { const it = items.find((x) => x.file === files[i].name) || items[i]; return (it && it.qty) || (o.specs && o.specs.qty) || 1; };
    const same = [];
    await Promise.all(files.map(async (g, i) => {
      if (i === index || !isStoreUrl(g.url) || kindOf(g) !== kind) return;
      try {
        const head = await fetch(g.url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        if (Number(head.headers.get('content-length')) !== bytes.length) return;
        if (sha(await downloadDesignFile(g.url)) === hash) same.push(i);
      } catch { /* can't compare: treat as different */ }
    }));
    same.sort((a, b) => a - b);

    const modelT = part.thickness;
    const thickness = Number(body.thickness_mm) > 0 ? Number(body.thickness_mm) : orderThickness(o) || modelT || 3.175;
    const suggested = [index, ...same].reduce((s, i) => s + itemQty(i), 0) * chosen.copies;
    const qty = Number.isInteger(Number(body.qty)) && Number(body.qty) >= 1 ? Number(body.qty) : suggested;
    const climb = body.climb === true;
    const name = baseName(f.name, o) + (parts.length > 1 ? `-part${partNo}` : '');
    if (same.length) part.assumptions.unshift(`The same file is on this order ${same.length + 1} times (${[index, ...same].map((i) => `#${i + 1}`).join(', ')}): it's one part, so make its toolpath once, for all the copies.`);

    const cam = Array.isArray(o.cam) ? o.cam : [];
    const nextVersion = 1 + cam.filter((c) => c.file_name === f.name && c.part === partNo).reduce((v, c) => Math.max(v, c.v), 0);
    const plan = planSheet(part, { thickness, qty, climb, name, material: o.specs && o.specs.material, version: body.save ? nextVersion : null });
    const info = {
      file: index, file_name: f.name, part: partNo, parts: parts.map((p, i) => ({ part: i + 1, copies: p.copies })),
      defaults: { thickness_mm: Math.round((orderThickness(o) || modelT || 3.175) * 1000) / 1000, qty: suggested },
      model_thickness_mm: modelT ? Math.round(modelT * 1000) / 1000 : null, same_as: same, next_version: nextVersion
    };
    if (!body.save) return Response.json({ ...info, report: plan.report, svg: plan.svg, svg_cut: plan.svg_cut, svg_part: plan.svg_part }, { headers: noStore });

    // The files, then the order's list of them.
    const latest = await getOrder(body.id);
    const list = Array.isArray(latest.order.cam) ? latest.order.cam : [];
    if (body.reuse) {
      const at = list.map((c, i) => [c, i]).reverse().find(([c]) => c.file_name === f.name && c.part === partNo && c.gen === GEN &&
        c.qty === qty && c.climb === climb && Math.abs(c.thickness_mm - thickness) < 0.0005);
      if (at) {
        return Response.json({ ...info, next_version: nextVersion, entry: at[0], index: at[1], reused: true, cam: list, report: plan.report, svg: plan.svg, svg_cut: plan.svg_cut, svg_part: plan.svg_part }, { headers: noStore });
      }
    }
    const v = 1 + list.filter((c) => c.file_name === f.name && c.part === partNo).reduce((n, c) => Math.max(n, c.v), 0);
    const final = v === nextVersion ? plan : planSheet(part, { thickness, qty, climb, name, material: o.specs && o.specs.material, version: v });
    const notes = reportText(final.report, { version: v }) +
      '\nTabs: none in this file. Carbide Create keeps tabs on the drawing in a form this website can\'t write yet, so add them (Edit Tabs) on the inside and outside contours before cutting. The .nc file of the same version has them.\n' +
      'Carbide Motion: open and save this file in Carbide Create once before sending it to Carbide Motion.\n';
    const dir = `cam/${o.id}/${crypto.randomBytes(16).toString('hex')}/${name}-V${v}`;
    const opts = { access: 'public', addRandomSuffix: false };
    const [nc, c2d] = await Promise.all([
      put(`${dir}.nc`, final.gcode, { ...opts, contentType: 'text/plain; charset=utf-8' }),
      put(`${dir}.c2d`, c2dFile(final.sheet, notes), { ...opts, contentType: 'application/octet-stream' })
    ]);
    const r = final.report;
    const entry = {
      v, gen: GEN, file_name: f.name, part: partNo, name: `${name}-V${v}`, at: new Date().toISOString(),
      thickness_mm: Math.round(thickness * 1000) / 1000, qty, climb,
      stock_in: [r.stock.w_in, r.stock.h_in], minutes: r.run_minutes,
      skipped: r.skipped.length, problems: r.problems.length, nc: nc.url, c2d: c2d.url
    };
    const order = await updateOrder(o.id, { cam: [...list, entry] });
    return Response.json({ ...info, next_version: v + 1, entry, index: list.length, cam: order ? order.cam : [...list, entry], report: r, svg: final.svg, svg_cut: final.svg_cut, svg_part: final.svg_part }, { headers: noStore });
  } catch (err) {
    if (err instanceof CamError || err instanceof UserError) return fail(err.message);
    console.error('Toolpath failed:', err);
    return fail('Making the toolpath failed: ' + (err && err.message), 500);
  }
}
