import crypto from 'node:crypto';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { STATUSES, getOrder, isValidId, listOrders, updateOrder } from '../_lib/orders.js';
import { orderChanges } from '../_lib/changes.js';
import { UserError, analyzeStep, downloadDesignFile, isStepUrl, isStoreUrl } from '../_lib/step.js';

// The Claude connector: a remote MCP server (Streamable HTTP, stateless) at
// /api/mcp/<CLAUDE_CONNECTOR_KEY>. The key in the path is its only credential,
// separate from ADMIN_PASSWORD so it can be revoked on its own (change or delete
// the env var, then redeploy). It can read orders, measure their STEP files
// (api/_lib/step.js), and change status, notes and delivery details, through the
// same rules as the admin API. It can't delete orders or touch passwords, keys or
// settings. Every change it makes is added to the order's activity history, which
// the admin panel shows.

// Every refusal is this same response, so it tells nothing about the key.
const notFound = () => new Response('Not found', {
  status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
});

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

// Constant-time compare of the key in the URL against CLAUDE_CONNECTOR_KEY. Both
// are hashed first so the buffers are always the same length (as in isAdmin).
// A missing or short (under 32 characters) CLAUDE_CONNECTOR_KEY turns the
// connector off. The key is never logged or echoed back.
function keyMatches(request) {
  const expected = (process.env.CLAUDE_CONNECTOR_KEY || '').trim();
  // Vercel passes the [key] segment as ?key=; the path itself is the fallback.
  const url = new URL(request.url);
  const given = url.searchParams.get('key') ?? url.pathname.split('/').pop() ?? '';
  // Compared even when the connector is off, so every refusal takes the same work.
  const same = crypto.timingSafeEqual(sha256(given), sha256(expected));
  return same && expected.length >= 32;
}

// ---- Shapes returned to Claude ----

// Same fallback as the admin panel: orders from before specs were saved go by their part type.
function kindOf(o) {
  if (o.specs && ['cnc', 'print', 'other'].includes(o.specs.kind)) return o.specs.kind;
  return /cnc|plate/i.test(o.part_type || '') ? 'cnc' : /print/i.test(o.part_type || '') ? 'print' : 'other';
}

function total(o) {
  const sp = o.specs, q = o.quote;
  if (q) return Math.round((q.total + (q.shipping || 0)) * 100) / 100; // the shop's hand quote
  if (sp && sp.price && sp.price.total > 0) return Math.round(sp.price.total * 100) / 100; // dollars, to the cent
  if (o.escalated || (sp && sp.reason) || !o.price) return 'hand quote';
  return o.price; // older orders: the price text as emailed
}

// Every design file on an order as { name, url }; orders from before multi-file
// quotes only have design_file / file_name.
function filesOf(o) {
  if (Array.isArray(o.files) && o.files.length) return o.files;
  return o.design_file ? [{ name: o.file_name || '', url: o.design_file }] : [];
}

function summary(o) {
  const sp = o.specs || {};
  return {
    id: o.id, created: o.createdAt, name: o.name, team: o.team || '', kind: kindOf(o),
    qty: sp.qty ?? null, files: filesOf(o).length, material: sp.material || '', status: o.status,
    delivery: o.delivery, delivery_date: o.delivery_date || '', delivery_stop: o.delivery_stop || 0, delivered_at: o.delivered_at || '',
    total: total(o), ...(o.quote ? { quoted: true } : sp.price && sp.price.partial ? { plus_hand_quote: true } : {}),
    ...(o.delivery === 'ship' && (o.quote ? o.quote.shipping === null : !(sp.price && sp.price.delivery)) ? { plus_shipping: true } : {}),
    ...(sp.shipping_box ? { shipping_box: sp.shipping_box } : {}),
    ...((sp.items || []).some((it) => it.checks && it.checks.length) ? { check: true } : {}),
    ...(sp.discount ? { discount_code: sp.discount.code + (sp.discount.invalid ? ' (not valid: ' + sp.discount.invalid + ')' : ' (' + sp.discount.label + ')') } : {})
  };
}

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

// Runs a tool body, turning storage failures into a plain error for Claude.
async function guarded(what, run) {
  try {
    return await run();
  } catch (err) {
    console.error(`Claude connector: ${what} failed:`, err);
    return fail(`Could not ${what}. Try again in a moment.`);
  }
}

// Validates through the same rules as the admin API (api/_lib/changes.js), saves,
// and records the change in the order's history as made by Claude.
function write(id, fields) {
  if (!isValidId(id)) return fail('Bad id');
  const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (!Object.keys(body).length) return fail('Nothing to change');
  const { changes, error } = orderChanges(body);
  if (error) return fail(error);
  return guarded('save the order', async () => {
    const order = await updateOrder(id, changes, { by: 'claude' });
    return order ? json({ saved: summary(order), changed: changes }) : fail('Not found');
  });
}

// Lines a measured file up with what was ordered: flags parts whose thickness
// doesn't match the stock on the order (e.g. "6061 aluminum, 1/8 in."), and
// scales the time and electricity totals by how many of that file were ordered.
function checkAgainstOrder(report, o, qty) {
  const sp = o.specs || {};
  const frac = String(sp.material || '').match(/(\d+)\s*\/\s*(\d+)\s*in/);
  if (frac) {
    const mm = (Number(frac[1]) / Number(frac[2])) * 25.4;
    for (const p of report.parts) {
      if (p.thickness_mm && Math.abs(p.thickness_mm - mm) > 0.1) {
        p.flags.push(`The file is ${p.thickness_mm} mm thick, but the order is for ${frac[1]}/${frac[2]} in. (${Math.round(mm * 100) / 100} mm) stock: check with the customer which they want.`);
      }
    }
  }
  if (qty > 1 && report.totals_all_copies) {
    const t = report.totals_all_copies;
    report.totals_for_order = {
      order_qty: qty, note: 'The file\'s parts times the quantity ordered.',
      machine_minutes: Math.round(t.machine_minutes * qty * 10) / 10,
      kwh: Math.round(t.kwh * qty * 1000) / 1000,
      electricity_usd: Math.round(t.electricity_usd * qty * 100) / 100
    };
  }
}

// ---- Tools ----

const ID = { type: 'string', description: 'The order id, as given by list_orders (e.g. "mg5x2k1a-0123456789abcdef01234567").' };
const READ = { readOnlyHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function buildServer() {
  const server = new McpServer({ name: 'crackbotics-orders', version: '1.5.0' }, {
    instructions: 'Crackbotics is a student-run CNC and 3D-print shop for FTC robotics teams. These tools read and update its order log. ' +
      'An order moves new → quoted → paid → in-progress → ready → done (or cancelled). Paid, in-progress and ready delivery orders go on a delivery day. ' +
      'An order is picked up in San Diego (delivery "pickup"), delivered locally for a flat $15.99 ("delivery"), or shipped anywhere in the US ("ship"); ' +
      'shipping is in the total when the quote page could fit the parts in a USPS flat rate box (specs.shipping_box, cost in specs.price.delivery), otherwise it\'s quoted by hand. A discount code on an order (specs.discount) was checked when the order came in; ' +
      'its dollar amount is already taken off the total (specs.price.code_discount), or, for a hand quote, still has to be. ' +
      'Every change you make is saved in the order\'s history, which the shop\'s admins can see. Orders can\'t be deleted from here. ' +
      'An order can have several design files, one per part, each with its own quantity (get_order: files, and specs.items for each file\'s line). ' +
      'The quote page prices DXF and STEP plates itself. A STEP file with something unusual (sloped faces, features on both faces, a step around the edge, ' +
      'holes under the 1/8 in. tool, a thickness other than the 1/8 in. on the order, several different parts) is still priced, and its specs.items entry ' +
      'lists checks for the shop to look over before confirming the price. analyze_part_file measures STEP files the same way the quote page does ' +
      '(plate size, thickness, cut length, holes, pockets) and adds machine time, electricity and a picture.'
  });

  server.registerTool('list_orders', {
    title: 'List orders',
    description: 'List orders, newest first, as a short summary each: id, created date, name, team, kind (cnc/print/other), quantity, material, ' +
      'status, delivery type (pickup, delivery or ship), delivery date and stop number, delivered time, number of design files, and total in dollars (or "hand quote" when it needs pricing by hand; ' +
      'quoted: true when the total is the shop\'s hand quote, plus_hand_quote: true when some of its files still need pricing by hand, plus_shipping: true when shipping still has to be added, discount_code when it used one, ' +
      'check: true when a file was priced automatically but flagged for a look before confirming). ' +
      'Use get_order for the full details of one order.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...STATUSES, 'open'], description: 'Only orders with this status. "open" means not done or cancelled yet.' },
        kind: { type: 'string', enum: ['cnc', 'print', 'other'], description: 'Only CNC plates, 3D prints, or other jobs.' },
        search: { type: 'string', description: 'Text to look for in the customer name, team number, email, or part description (not case-sensitive).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Most orders to return (default 50).' }
      },
      additionalProperties: false
    }),
    annotations: READ
  }, ({ status, kind, search, limit }) => guarded('load orders', async () => {
    const term = (search || '').trim().toLowerCase();
    const matches = (await listOrders()).filter((o) => {
      if (status === 'open' ? ['done', 'cancelled'].includes(o.status) : status && o.status !== status) return false;
      if (kind && kindOf(o) !== kind) return false;
      return !term || [o.name, o.team, o.email, o.part, o.part_type].join(' ').toLowerCase().includes(term);
    });
    const shown = matches.slice(0, limit ?? 50);
    return json({ matching: matches.length, shown: shown.length, orders: shown.map(summary) });
  }));

  server.registerTool('get_order', {
    title: 'Get one order',
    description: 'Everything about one order: what was ordered (specs: kind, material, quantity, color, infill, walls, CNC options, rush, measured size, file type), ' +
      'the price breakdown (or the reason it needs a hand quote) and quote (the price quoted by hand, if any), customer name, email and team, pickup or delivery with address, date, time window, ' +
      'stop number and delivered time, status, private notes, the design files (files: name and download URL of each, in order; specs.items has each ' +
      'file\'s quantity, measurements and price or hand-quote reason, plus checks: what to look over before confirming that file\'s price), the original ' +
      'quote text, and the history of changes made through this connector.',
    inputSchema: fromJsonSchema({ type: 'object', properties: { id: ID }, required: ['id'], additionalProperties: false }),
    annotations: READ
  }, ({ id }) => {
    if (!isValidId(id)) return fail('Bad id');
    return guarded('load the order', async () => {
      const found = await getOrder(id);
      return found ? json({ ...found.order, kind: kindOf(found.order) }) : fail('Not found');
    });
  });

  server.registerTool('update_order', {
    title: 'Update status, notes, tracking or quoted price',
    description: `Change an order's status, its private notes, its shipping tracking number, its quoted price, or any of them. Status must be one of: ${STATUSES.join(', ')}. ` +
      'Notes replace the whole private notes field (up to 4000 characters), so to add to them, read the current notes with get_order first and send the full new text. ' +
      'The quoted price is what the shop quoted by hand (quote_total for the parts, quote_shipping for shipping or delivery, quote_note for what it covers); ' +
      'it replaces the estimate in list_orders and on the customer\'s status page. Send all three together (quote_total 0 clears it). ' +
      'Customers never see notes; they do see the tracking number and the quoted price, on their order status page. Marking an order handed over or shipped is mark_delivered.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        id: ID,
        status: { type: 'string', description: `New status: one of ${STATUSES.join(', ')}.` },
        notes: { type: 'string', description: 'The full new private notes text. Replaces what is there now.' },
        tracking: { type: 'string', description: 'Carrier tracking number for a shipped order (letters, digits, spaces, dashes; up to 40). "" clears it.' },
        quote_total: { type: 'number', minimum: 0, description: 'The quoted price for the parts, in dollars (any discount already taken off). 0 clears the quote.' },
        quote_shipping: { type: 'number', minimum: 0, description: 'Quoted shipping or delivery, in dollars. Leave it out when it isn\'t quoted yet or isn\'t needed.' },
        quote_note: { type: 'string', description: 'What the quote covers, e.g. "1/8 in. 6061, 2 of each plate" (up to 300 characters).' }
      },
      required: ['id'],
      additionalProperties: false
    }),
    annotations: EDIT
  }, ({ id, status, notes, tracking, quote_total, quote_shipping, quote_note }) => {
    if (quote_total === undefined && (quote_shipping !== undefined || quote_note !== undefined)) return fail('Give quote_total with quote_shipping and quote_note.');
    const quote = quote_total === undefined ? undefined : quote_total === 0 ? null : { total: quote_total, shipping: quote_shipping ?? null, note: quote_note || '' };
    return write(id, { status, notes, tracking, quote });
  });

  server.registerTool('schedule_delivery', {
    title: 'Schedule a delivery or pickup',
    description: 'Set when an order is delivered or picked up: the day, the time window, and its stop number in that day\'s delivery route ' +
      '(list_orders shows each order\'s day and stop). Give any of them; the rest stay as they are. An order moved to another day keeps its stop number ' +
      'unless you give a new one, so give delivery_stop too (usually one past the last stop that day). To unschedule, send delivery_date "" and delivery_stop 0 ' +
      '(the admin panel puts paid, in-progress and ready delivery orders back on the next delivery day by itself).',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        id: ID,
        delivery_date: { type: 'string', description: 'The day as YYYY-MM-DD (a real calendar date), or "" to clear it.' },
        delivery_window: { type: 'string', description: 'Time window as short free text, e.g. "4–6 pm" (up to 40 characters). "" clears it.' },
        delivery_stop: { type: 'integer', description: 'Position in that day\'s route: a whole number from 0 to 999, where 1 is the first stop and 0 means none.' }
      },
      required: ['id'],
      additionalProperties: false
    }),
    annotations: EDIT
  }, ({ id, delivery_date, delivery_window, delivery_stop }) => write(id, { delivery_date, delivery_window, delivery_stop }));

  server.registerTool('mark_delivered', {
    title: 'Mark delivered, picked up or shipped',
    description: 'Record that an order was handed over or shipped (delivered: true saves the current time) or undo that (delivered: false clears it). ' +
      'This doesn\'t change the status: the admin panel\'s Delivered button also sets the status to done, so use update_order for that too.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        id: ID,
        delivered: { type: 'boolean', description: 'true when the order has been handed over, false to undo.' }
      },
      required: ['id', 'delivered'],
      additionalProperties: false
    }),
    annotations: EDIT
  }, ({ id, delivered }) => write(id, { delivered }));

  server.registerTool('analyze_part_file', {
    title: 'Measure an order\'s STEP files',
    description: 'Download the order\'s STEP (.step/.stp) design files and measure every part in each as a CNC plate: thickness and the matching ' +
      'stock size, plate size and stock area, total cut length, round holes by diameter, other cutouts, pockets (area and depth), flags for parts with sloped ' +
      'faces, features on both faces or a step around the edge, holes smaller than the shop\'s 1/8 in. tool, and identical copies grouped. Also estimates ' +
      'machine minutes, kWh and electricity cost per part, per file (times how many of that file were ordered) and for the whole order, from the ' +
      'shop\'s cutting constants (an estimate, not a CAM toolpath), and returns a top-view picture of each distinct part. An order can have up to ' +
      '10 files: by default every STEP file is measured, or give file (its number, 1 = first, as listed by get_order\'s files) for just one. ' +
      'The material isn\'t in the files: take it from get_order. Only works on the order\'s own uploaded files. The quote page already priced ' +
      'DXF files and most STEP files with these same measurements: use this to check a flagged one or to quote one by hand. Takes a few seconds per file, up to about 30 for a big one; if time runs out, the reply says which files to ask for next.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        id: ID,
        file: { type: 'integer', minimum: 1, maximum: 10, description: 'Measure only this file: its number on the order (1 = the first file).' }
      },
      required: ['id'],
      additionalProperties: false
    }),
    annotations: READ
  }, async ({ id, file }) => {
    if (!isValidId(id)) return fail('Bad id');
    let found;
    try {
      found = await getOrder(id);
    } catch (err) {
      console.error('Claude connector: load the order failed:', err);
      return fail('Could not load the order. Try again in a moment.');
    }
    if (!found) return fail('Not found');
    const o = found.order, sp = o.specs || {};
    const all = filesOf(o).map((f, i) => ({ ...f, number: i + 1 }));
    if (!all.length) return fail('This order has no design files.');
    let targets;
    if (file !== undefined) {
      const f = all.find((x) => x.number === file);
      if (!f) return fail(`This order has ${all.length} file${all.length === 1 ? '' : 's'}: pick a number from 1 to ${all.length}.`);
      targets = [f];
    } else {
      targets = all.filter((f) => isStepUrl(f.url) || /\.(step|stp)$/i.test(f.name || ''));
      if (!targets.length) return fail(`None of this order's files is a STEP file (${all.map((f) => f.name || 'unnamed').join(', ')}). This tool measures .step and .stp files only.`);
    }

    // Files one at a time, inside the function's time limit: past 25 s no new
    // file is started, and the reply lists the ones left for another call.
    const started = Date.now(), results = [], pictures = [], left = [];
    for (const f of targets) {
      if (results.length && Date.now() - started > 25000) { left.push(f.number); continue; }
      const entry = { file: f.number, name: f.name || '' };
      results.push(entry);
      if (!f.url || f.url.startsWith('UPLOAD FAILED')) { entry.error = 'This file didn\'t upload: ask the customer to email it.'; continue; }
      if (!isStoreUrl(f.url)) { entry.error = 'This file isn\'t in the shop\'s file store, so it won\'t be downloaded.'; continue; }
      if (!isStepUrl(f.url)) { entry.error = 'Not a STEP file. This tool measures .step and .stp files only.'; continue; }
      try {
        const { report, pictures: pics } = await analyzeStep(await downloadDesignFile(f.url));
        // How many of this file were ordered: its own line, or the order's quantity for a single-file order.
        const item = (sp.items || [])[f.number - 1];
        const qty = Number(item ? item.qty : sp.qty) || 1;
        checkAgainstOrder(report, o, qty);
        Object.assign(entry, { qty_ordered: qty }, report);
        for (const p of pics) pictures.push({ label: `File ${f.number} (${f.name || 'unnamed'}), part ${p.part}, top view:`, image: p.image });
      } catch (err) {
        if (!(err instanceof UserError)) console.error('Claude connector: analyze a design file failed:', err);
        entry.error = err instanceof UserError ? err.message : 'Could not analyze this file. It may be damaged, or too complex to measure in time: quote it by hand.';
      }
    }

    const measured = results.filter((r) => !r.error);
    const order = { machine_minutes: 0, kwh: 0, electricity_usd: 0 };
    for (const r of measured) {
      const t = r.totals_for_order || r.totals_all_copies;
      order.machine_minutes += t.machine_minutes; order.kwh += t.kwh; order.electricity_usd += t.electricity_usd;
    }
    const payload = {
      order: summary(o),
      files: results,
      ...(measured.length > 1 ? { totals_all_files: {
        note: 'Every measured file, times how many of each were ordered.',
        machine_minutes: Math.round(order.machine_minutes * 10) / 10, kwh: Math.round(order.kwh * 1000) / 1000,
        electricity_usd: Math.round(order.electricity_usd * 100) / 100
      } } : {}),
      ...(left.length ? { not_measured_yet: `Out of time for this call: measure file${left.length === 1 ? '' : 's'} ${left.join(', ')} with the file parameter.` } : {})
    };
    if (!measured.length && results.length === 1) return fail(results[0].error);
    const MAX_PICTURES = 8;
    return {
      content: [
        { type: 'text', text: JSON.stringify(payload, null, 2) },
        ...pictures.slice(0, MAX_PICTURES).flatMap((p) => [
          { type: 'text', text: p.label },
          { type: 'image', data: p.image, mimeType: 'image/png' }
        ]),
        ...(pictures.length > MAX_PICTURES ? [{ type: 'text', text: `(${pictures.length - MAX_PICTURES} more pictures left out: ask for one file at a time to see them.)` }] : [])
      ]
    };
  });

  return server;
}

// Stateless: a fresh server per request, nothing kept between requests.
const mcp = createMcpHandler(buildServer);

async function handle(request) {
  if (!keyMatches(request)) return notFound();
  return mcp.fetch(request);
}

export const GET = handle, POST = handle, DELETE = handle, PUT = handle, PATCH = handle, OPTIONS = handle, HEAD = handle;
