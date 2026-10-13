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
  const sp = o.specs;
  if (sp && sp.price && sp.price.total > 0) return sp.price.total;
  if (o.escalated || (sp && sp.reason) || !o.price) return 'hand quote';
  return o.price; // older orders: the price text as emailed
}

function summary(o) {
  const sp = o.specs || {};
  return {
    id: o.id, created: o.createdAt, name: o.name, team: o.team || '', kind: kindOf(o),
    qty: sp.qty ?? null, material: sp.material || '', status: o.status,
    delivery: o.delivery, delivery_date: o.delivery_date || '', delivery_stop: o.delivery_stop || 0, delivered_at: o.delivered_at || '',
    total: total(o)
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

// ---- Tools ----

const ID = { type: 'string', description: 'The order id, as given by list_orders (e.g. "mg5x2k1a-0123456789abcdef01234567").' };
const READ = { readOnlyHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function buildServer() {
  const server = new McpServer({ name: 'crackbotics-orders', version: '1.1.0' }, {
    instructions: 'Crackbotics is a student-run CNC and 3D-print shop for FTC robotics teams. These tools read and update its order log. ' +
      'An order moves new → quoted → paid → in-progress → ready → done (or cancelled). Paid, in-progress and ready delivery orders go on a delivery day. ' +
      'Every change you make is saved in the order\'s history, which the shop\'s admins can see. Orders can\'t be deleted from here. ' +
      'STEP files are quoted by hand: analyze_part_file measures them (plate size, thickness, cut length, holes, pockets) and estimates machine time and electricity.'
  });

  server.registerTool('list_orders', {
    title: 'List orders',
    description: 'List orders, newest first, as a short summary each: id, created date, name, team, kind (cnc/print/other), quantity, material, ' +
      'status, delivery type (delivery or pickup), delivery date and stop number, delivered time, and total in dollars (or "hand quote" when it needs pricing by hand). ' +
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
      'the price breakdown (or the reason it needs a hand quote), customer name, email and team, pickup or delivery with address, date, time window, ' +
      'stop number and delivered time, status, private notes, the design file download URL, the original quote text, and the history of changes made through this connector.',
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
    title: 'Update status or notes',
    description: `Change an order's status, its private notes, or both. Status must be one of: ${STATUSES.join(', ')}. ` +
      'Notes replace the whole private notes field (up to 4000 characters), so to add to them, read the current notes with get_order first and send the full new text. ' +
      'Customers never see notes. Marking a delivery handed over is mark_delivered.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        id: ID,
        status: { type: 'string', description: `New status: one of ${STATUSES.join(', ')}.` },
        notes: { type: 'string', description: 'The full new private notes text. Replaces what is there now.' }
      },
      required: ['id'],
      additionalProperties: false
    }),
    annotations: EDIT
  }, ({ id, status, notes }) => write(id, { status, notes }));

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
    title: 'Mark delivered or picked up',
    description: 'Record that an order was handed over (delivered: true saves the current time) or undo that (delivered: false clears it). ' +
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
    title: 'Measure an order\'s STEP file',
    description: 'Download the order\'s STEP (.step/.stp) design file and measure every part in it as a CNC plate: thickness and the matching ' +
      'stock size, plate size and stock area, total cut length, round holes by diameter, other cutouts, pockets (area and depth), parts with sloped ' +
      'or bottom-side features that need a hand quote, holes smaller than the shop\'s 1/8 in. tool, and identical copies grouped. Also estimates ' +
      'machine minutes, kWh and electricity cost per part and for all copies, from the shop\'s cutting constants (an estimate, not a CAM toolpath), ' +
      'and returns a top-view picture of each distinct part. The material isn\'t in the file: take it from get_order. Only works on the order\'s own ' +
      'uploaded file; DXF files are already priced by the quote page. Takes a few seconds, up to about 30 for big files.',
    inputSchema: fromJsonSchema({ type: 'object', properties: { id: ID }, required: ['id'], additionalProperties: false }),
    annotations: READ
  }, async ({ id }) => {
    if (!isValidId(id)) return fail('Bad id');
    let found;
    try {
      found = await getOrder(id);
    } catch (err) {
      console.error('Claude connector: load the order failed:', err);
      return fail('Could not load the order. Try again in a moment.');
    }
    if (!found) return fail('Not found');
    const o = found.order, url = o.design_file || '';
    const name = o.file_name || url.split('/').pop() || '';
    if (!url || url.startsWith('UPLOAD FAILED')) return fail('This order has no design file.');
    if (!isStoreUrl(url)) return fail('The design file isn\'t in the shop\'s file store, so it won\'t be downloaded.');
    if (!isStepUrl(url)) return fail(`The design file (${name}) isn't a STEP file. This tool measures .step and .stp files only.`);
    try {
      const { report, pictures } = await analyzeStep(await downloadDesignFile(url));
      return {
        content: [
          { type: 'text', text: JSON.stringify({ order: summary(o), file: name, ...report }, null, 2) },
          ...pictures.flatMap((p) => [
            { type: 'text', text: `Part ${p.part}, top view:` },
            { type: 'image', data: p.image, mimeType: 'image/png' }
          ])
        ]
      };
    } catch (err) {
      if (err instanceof UserError) return fail(err.message);
      console.error('Claude connector: analyze the design file failed:', err);
      return fail('Could not analyze the design file. It may be damaged, or too complex to measure in time: quote it by hand.');
    }
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
