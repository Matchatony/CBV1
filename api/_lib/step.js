import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';
import occtimportjs from 'occt-import-js';
import { READ_OPTIONS, MM_PER_IN, cutLength, machineMinutes, measureModel, measureStepText, passesFor } from '../../step-measure.js';

// STEP file analysis for the Claude connector's analyze_part_file tool.
// step-measure.js (which the quote page prices STEP plates with) measures each
// solid as a CNC plate: thickness, plate size, the length of every contour the
// router follows, holes, pockets and flags, straight from the file's geometry,
// or, for a file it can't read that way, from OpenCascade's mesh of it
// (occt-import-js, the same WebAssembly build the quote page uses). This adds
// an estimate of machine time and electricity, and draws a top view of each
// distinct part.

// Shop constants. The first block copies RATE in index.html (keep them in sync);
// the rest are only used here. All time and cost figures are estimates.
export const SHOP = {
  cncSetupMin: 3,          // per part
  cncFeedIpm: 25,          // cutting feed, inches per minute
  cncPasses: 3,            // depth passes for 1/8 in. stock; thicker stock scales from this
  cncPerHoleMin: 0.25,     // plunge, lead-in and retract per round hole
  minToolDiaIn: 0.125,     // smallest end mill
  pocketStepoverIn: 0.05,  // sideways step when clearing a pocket (40% of a 1/8 in. tool)
  // Electricity: the shop's Shapeoko 5 Pro 2x2 with the Carbide Compact Router,
  // at their rated draw: the router is about 6.5 A at 120 V (~780 W, flat out)
  // and the machine is rated 4 A (~440 W), so 1.2 kW at most. Real cutting
  // draws less; a plug-in power meter would give the true figure. The price is
  // SDG&E's 2026 blended residential rate, about $0.49/kWh (time-of-use runs
  // ~$0.39 to $0.70). Set SHOP_MACHINE_KW / SHOP_USD_PER_KWH in Vercel to
  // override either; add a shop vac's draw if one runs during cuts.
  machineKw: Number(process.env.SHOP_MACHINE_KW) || 1.2,
  usdPerKwh: Number(process.env.SHOP_USD_PER_KWH) || 0.49
};

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // same cap as uploads (api/upload.js)
// OpenCascade's meshing time grows faster than the face count (about 4 s at 200
// faces, 9 s at 400, a minute at 1,800), so a bigger model that can't be read
// directly is turned away instead of running into the function's time limit.
const MAX_FACES = 1000;
const MAX_PICTURES = 6;

// ---- Loading and fetching ----

// Started on first use and kept for the life of the function instance. The
// WebAssembly binary is read from disk directly (vercel.json ships it).
let occtReady = null;
function occt() {
  if (!occtReady) {
    const main = createRequire(import.meta.url).resolve('occt-import-js');
    const wasmBinary = fs.readFileSync(path.join(path.dirname(main), 'occt-import-js.wasm'));
    occtReady = occtimportjs({ wasmBinary });
    occtReady.catch(() => { occtReady = null; });
  }
  return occtReady;
}

// Only design files in the shop's own Blob store (what api/order.js accepts),
// never an arbitrary URL.
const FILE_URL = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/quotes\/[^?#]+$/;
export const isStoreUrl = (url) => FILE_URL.test(url || '');
export const isStepUrl = (url) => /\.(step|stp)$/i.test(url || '');

export async function downloadDesignFile(url) {
  if (!FILE_URL.test(url || '')) throw new UserError('The order\'s design file isn\'t in the shop\'s file store.');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new UserError(`The design file couldn't be downloaded (HTTP ${res.status}).`);
  if (Number(res.headers.get('content-length')) > MAX_FILE_BYTES) throw new UserError('The design file is over 10 MB.');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_FILE_BYTES) throw new UserError('The design file is over 10 MB.');
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

// An error whose message is meant for Claude (bad file, not a STEP file, ...).
export class UserError extends Error {}

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

// Machine time (step-measure.js), electricity and depth passes for one part.
function estimate(m) {
  const minutes = machineMinutes(m, SHOP);
  const kwh = (minutes / 60) * SHOP.machineKw;
  return { machine_minutes: r1(minutes), kwh: r3(kwh), electricity_usd: r2(kwh * SHOP.usdPerKwh), passes_full_depth: passesFor(m.thickness, SHOP) };
}

// ---- Top-view picture ----

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width, height, rgb) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Gray: the plate. Blue: pocket floors (darker = deeper). Openings show the
// background. Light grid lines every 10 mm, darker every 50 mm, for scale.
function picture(m) {
  const cos = Math.cos(-m.rect.angle), sin = Math.sin(-m.rect.angle);
  const rot = ([x, y]) => [x * cos - y * sin, x * sin + y * cos];
  const top = m.topLoops.map((l) => l.map(rot));
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const l of top) for (const [x, y] of l) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x0 === Infinity) return null;
  const margin = 20, longest = 800;
  const scale = (longest - 2 * margin) / Math.max(x1 - x0, y1 - y0, 1e-6);
  const W = Math.ceil((x1 - x0) * scale) + 2 * margin, H = Math.ceil((y1 - y0) * scale) + 2 * margin;
  const px = ([x, y]) => [margin + (x - x0) * scale, H - margin - (y - y0) * scale];
  const img = Buffer.alloc(W * H * 3, 255);
  const set = (x, y, [r, g, b]) => { const i = (y * W + x) * 3; img[i] = r; img[i + 1] = g; img[i + 2] = b; };
  for (let mm = 0; mm <= (x1 - x0); mm += 10) { const x = Math.round(margin + mm * scale); for (let y = 0; y < H; y++) set(x, y, mm % 50 ? [232, 232, 236] : [205, 205, 212]); }
  for (let mm = 0; mm <= (y1 - y0); mm += 10) { const y = Math.round(H - margin - mm * scale); for (let x = 0; x < W; x++) set(x, y, mm % 50 ? [232, 232, 236] : [205, 205, 212]); }
  const fill = (loops, color) => {
    const edges = loops.flatMap((l) => l.map(px).map((p, i, a) => [p, a[(i + 1) % a.length]]));
    for (let y = 0; y < H; y++) {
      const yc = y + 0.5, xs = [];
      for (const [[ax, ay], [bx, by]] of edges) if ((ay > yc) !== (by > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.max(0, Math.ceil(xs[i] - 0.5)); x <= Math.min(W - 1, Math.floor(xs[i + 1] - 0.5)); x++) set(x, y, color);
    }
  };
  fill(top, [138, 143, 152]);
  const deepest = m.floors.reduce((d, f) => Math.max(d, f.depth), 1e-6);
  for (const f of [...m.floors].sort((a, b) => a.depth - b.depth)) {
    const t = f.depth / deepest;
    fill(f.loops.map((l) => l.map(rot)), [Math.round(150 - 90 * t), Math.round(190 - 90 * t), Math.round(235 - 40 * t)]);
  }
  return png(W, H, img).toString('base64');
}

// ---- Whole file ----

// The model's solids measured as plates (step-measure.js): straight from the
// file when it can, else from OpenCascade's mesh (mesh: true). opts go to
// measureStepText (api/_lib/cam.js asks for finer curves and the face loops).
export async function readStepModel(bytes, opts) {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 200)).toString('latin1');
  if (!head.includes('ISO-10303-21')) throw new UserError('This isn\'t a STEP file (no ISO-10303-21 header).');
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('latin1');
  // Most plates are read straight from the file, quickly at any size; anything
  // else goes through OpenCascade.
  let model = null;
  try {
    model = measureStepText(text, SHOP, opts);
  } catch (err) {
    console.error('Reading the STEP geometry directly failed:', err);
  }
  if (model) return { model, mesh: false };
  const faceCount = (text.match(/\b(ADVANCED_FACE|FACE_SURFACE)\s*\(/g) || []).length;
  if (faceCount > MAX_FACES) throw new UserError(`This model has ${faceCount} faces, over the ${MAX_FACES} this tool can measure in time. Quote it by hand, or ask for the plates as separate files.`);
  const lib = await occt();
  const result = lib.ReadStepFile(bytes, READ_OPTIONS);
  if (!result || !result.success) throw new UserError('The file couldn\'t be read as a STEP model.');
  if (!result.meshes || !result.meshes.length) throw new UserError('The file has no solid geometry in it. It may be an assembly that only points to other part files: ask the customer for the parts themselves, or one STEP export with everything in it.');
  return { model: measureModel(result.meshes, SHOP), mesh: true };
}

export async function analyzeStep(bytes) {
  const { model } = await readStepModel(bytes);
  const { solids, groups } = model;

  const pictures = [];
  const parts = groups.map(({ m, copies }, i) => {
    const part = { part: i + 1, copies, volume_cm3: r2(m.volume / 1000), surface_area_mm2: r1(m.area) };
    if (!m.contours) return { ...part, flat_plate: false, flags: ['No flat faces: not a plate. Quote it by hand.'] };
    const kind = (t) => m.contours.filter((x) => x.type === t);
    const sizes = (list) => Object.entries(list.reduce((acc, x) => { const d = r2(x.diameter); acc[d] = (acc[d] || 0) + 1; return acc; }, {}))
      .map(([d, count]) => ({ diameter_mm: Number(d), diameter_in: r3(d / MM_PER_IN), count })).sort((a, b) => a.diameter_mm - b.diameter_mm);
    const cut = cutLength(m);
    const est = estimate(m);
    if (pictures.length < MAX_PICTURES) {
      const image = picture(m);
      if (image) pictures.push({ part: i + 1, image });
    }
    return {
      ...part,
      flat_plate: m.flat_plate,
      thickness_mm: r3(m.thickness), thickness_in: r3(m.thickness / MM_PER_IN), stock: m.stock,
      plate_size_mm: [r1(m.rect.length), r1(m.rect.width)],
      plate_size_in: [r2(m.rect.length / MM_PER_IN), r2(m.rect.width / MM_PER_IN)],
      stock_area_in2: r2((m.rect.length * m.rect.width) / MM_PER_IN ** 2),
      cut_length_mm: r1(cut), cut_length_in: r1(cut / MM_PER_IN),
      holes: { count: kind('hole').length, sizes: sizes(kind('hole')) },
      cutouts: kind('cutout').length,
      pockets: kind('pocket').map((x) => ({ area_mm2: r1(x.area), depth_mm: r2(x.depth), ...(x.diameter ? { diameter_mm: r2(x.diameter) } : {}) })),
      flags: m.flags.map((f) => f.text),
      estimate_each: est
    };
  });

  const totals = parts.reduce((t, p) => {
    if (!p.estimate_each) return t;
    t.machine_minutes += p.estimate_each.machine_minutes * p.copies;
    t.kwh += p.estimate_each.kwh * p.copies;
    t.electricity_usd += p.estimate_each.electricity_usd * p.copies;
    return t;
  }, { machine_minutes: 0, kwh: 0, electricity_usd: 0 });

  return {
    report: {
      units: 'mm (inches where marked)',
      solids, distinct_parts: parts.length, parts,
      totals_all_copies: { machine_minutes: r1(totals.machine_minutes), kwh: r3(totals.kwh), electricity_usd: r2(totals.electricity_usd) },
      assumptions: {
        note: 'Time and electricity are estimates from the shop constants below, not a CAM toolpath. The material is not in the file: check the order.',
        depth_per_pass_mm: r3((0.125 * MM_PER_IN) / SHOP.cncPasses), feed_ipm: SHOP.cncFeedIpm, setup_min_per_part: SHOP.cncSetupMin,
        per_hole_min: SHOP.cncPerHoleMin, pocket_stepover_in: SHOP.pocketStepoverIn,
        machine_kw: SHOP.machineKw, usd_per_kwh: SHOP.usdPerKwh
      },
      pictures: pictures.length ? 'One top view per distinct part follows (gray plate, blue pocket floors, darker = deeper, grid every 10 mm).' : 'none'
    },
    pictures
  };
}
