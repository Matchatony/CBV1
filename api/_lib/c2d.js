import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';

// The sheet planned by api/_lib/cam.js as a Carbide Create project (.c2d), so
// the shop can open it in Carbide Create, check it and make its own G-code.
// Carbide doesn't publish the format; this follows the public
// reverse-engineering notes and specimen files of github.com/phobicdotno/
// shapeoko-c2d (Carbide Create build 853): a SQLite database whose `items`
// rows hold zlib-compressed JSON (pretty-printed, 4-space indent, sorted keys)
// with `sz` the uncompressed size. Everything is in millimeters.
//
// What it holds: the stock, the parts' outlines and holes for every copy
// (features too small for the bit are drawn but get no toolpath), and three
// toolpaths: holes cleared as pockets, bigger openings cut inside, outside
// profiles last. Two things it can't hold:
//   - tabs: Carbide keeps them on the drawing, in a form nobody has decoded
//     yet, so the contours have none until they're added in Carbide Create
//     (the .nc file has them);
//   - Carbide Motion's own G-code, which only Carbide Create can write, so the
//     file has to be opened and saved in Carbide Create once before Carbide
//     Motion can run it.

const KAPPA = 0.5522847498307936;
const LAYER = { blue: 0, green: 0, locked: false, name: 'DEFAULT', red: 0, uuid: '', visible: true };
const uuid = () => `{${crypto.randomUUID()}}`;

// The specimen's table definitions, word for word.
const SCHEMA = [
  `CREATE TABLE metadata(
    key TEXT PRIMARY KEY,  -- name of the parameter
    value TEXT              -- value of the parameter
)`,
  `CREATE TABLE sqlar(
    name TEXT PRIMARY KEY,  -- name of the file
    mode INT,               -- access permissions
    mtime INT DEFAULT CURRENT_TIMESTAMP, -- last modification time
    sz INT,                 -- original file size
    data BLOB               -- compressed content
)`,
  `CREATE TABLE params(
    key TEXT PRIMARY KEY,  -- name of the parameter
    value TEXT              -- value of the parameter
)`,
  `CREATE TABLE items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE,
    name TEXT, -- optional nice name for debugging
    type TEXT,  -- type of the element (Group, element, layer, component, toolpaths, ...)
    version TEXT, -- version of the element format
    sz INT,       -- original size
    data BLOB
)`,
  `CREATE TABLE log(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time INT DEFAULT CURRENT_TIMESTAMP,
    type TEXT,
    name TEXT,
    data TEXT
)`
];

// JSON the way Carbide writes it: keys sorted, 4-space indent, final newline.
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
  return v;
}
const json = (obj) => Buffer.from(JSON.stringify(sorted(obj), null, 4) + '\n', 'utf8');
const pack = (buf) => zlib.deflateSync(buf, { level: 1 }); // zlib header 78 01, like Carbide's
const mm = (x) => Math.round(x * 1e6) / 1e6;

function circleElement(id, c, r) {
  const k = KAPPA * r;
  return {
    behavior: 3, center: [mm(c[0]), mm(c[1])],
    cp1: [[0, 0], [-r, k], [k, r], [r, -k], [-k, -r], [0, 0]].map((p) => p.map(mm)),
    cp2: [[0, 0], [-k, r], [r, k], [k, -r], [-r, -k], [0, 0]].map((p) => p.map(mm)),
    geometryType: 'circle', group_id: [], id, layer: LAYER,
    point_type: [0, 3, 3, 3, 3, 4],
    points: [[-r, 0], [0, r], [r, 0], [0, -r], [-r, 0], [0, 0]].map((p) => p.map(mm)),
    position: [mm(c[0]), mm(c[1])], radius: mm(r), smooth: [1, 1, 1, 1, 1, 1], tabs: []
  };
}

// A closed polygon as Carbide draws straight edges: each segment a bezier
// whose control points sit on its own ends.
function pathElement(id, pts) {
  const p = pts.map((q) => [mm(q[0]), mm(q[1])]);
  const n = p.length, first = p[0];
  const points = [...p, first, first];
  const cp1 = [first, ...p, first];
  const cp2 = [first, ...p.slice(1), first, first];
  return {
    behavior: 0, cp1, cp2, geometryType: 'path', group_id: [], id, layer: LAYER,
    point_type: [0, ...Array(n).fill(3), 4], points, position: [0, 0],
    smooth: [...Array(n + 1).fill(0), 1], tabs: []
  };
}

// The 1/8 in. flat end mill at the spec's speeds.
function toolFor(s) {
  return {
    angle: 0, corner_radius: 0, diameter: 3.175, display_mm: false, finish_allowance: 0, flutes: 2,
    length: 12.7, model: '102', name: '1/8 in. flat end mill', number: 102, overall_length: 3.175,
    plungerate: s.plunge, read_only: false, slot_depth: s.stepdown, slot_feedrate: s.feed, slot_rpm: s.rpm,
    surfacing_feedrate: s.feed, surfacing_rpm: s.rpm, surfacing_stepover: 50, type: 0, url: '',
    uuid: '{00000000-0000-0000-0000-000000000000}', vendor: 'Carbide 3D'
  };
}

// A plain picture of the drawing (Carbide redraws its own when it saves).
function previewSvg(sheet) {
  const PX = 3.779527559; // 96 dpi
  const y = (v) => ((sheet.H - v) * PX).toFixed(2);
  const out = [`<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<svg  version="1.1" xmlns="http://www.w3.org/2000/svg" width="${(sheet.W * PX).toFixed(1)}px" height="${(sheet.H * PX).toFixed(1)}px">`];
  for (const off of sheet.offsets) {
    for (const l of sheet.outlines) out.push(`<path d="M${l.map((p) => `${((p[0] + off[0]) * PX).toFixed(2)} ${y(p[1] + off[1])}`).join(' L')} Z" stroke="black" stroke-width="1" fill="none" />`);
    for (const h of sheet.holes) {
      if (h.circle) out.push(`<circle cx="${((h.circle.c[0] + off[0]) * PX).toFixed(2)}" cy="${y(h.circle.c[1] + off[1])}" r="${(h.circle.r * PX).toFixed(2)}" stroke="black" stroke-width="1" fill="none" />`);
      else out.push(`<path d="M${h.pts.map((p) => `${((p[0] + off[0]) * PX).toFixed(2)} ${y(p[1] + off[1])}`).join(' L')} Z" stroke="black" stroke-width="1" fill="none" />`);
    }
  }
  out.push('</svg>\n');
  return Buffer.from(out.join('\n'), 'utf8');
}

// sheet: planSheet's `sheet`; notes: plain text for Carbide's notes panel.
// Returns the .c2d file's bytes.
export function c2dFile(sheet, notes) {
  const speeds = { feed: 508, plunge: 254, rpm: 16000, stepdown: 0.635 };
  const rows = [];
  const add = (uuidValue, name, type, obj) => { const raw = json(obj); rows.push([uuidValue, name, type, 'J1', raw.length, pack(raw)]); };
  add('', 'DEFAULT', 'layer', LAYER);

  // The drawing, copy by copy, and which toolpath each shape belongs to.
  const groups = { pocket: [], inside: [], outside: [] };
  for (const off of sheet.offsets) {
    const at = (p) => [p[0] + off[0], p[1] + off[1]];
    for (const l of sheet.outlines) {
      const id = uuid();
      add(id, 'path', 'element', pathElement(id, l.map(at)));
      groups.outside.push(id);
    }
    for (const h of sheet.holes) {
      const id = uuid();
      if (h.circle) add(id, 'circle', 'element', circleElement(id, at(h.circle.c), h.circle.r));
      else add(id, 'path', 'element', pathElement(id, h.pts.map(at)));
      if (groups[h.op]) groups[h.op].push(id);
    }
  }

  const group = uuid();
  add(group, '', 'toolpath_group', { enabled: true, expanded: true, name: 'Group 1', uuid: group });
  const common = (name, elements) => ({
    automatic_parameters: false, elements: elements.map((u) => ({ uuid: u })), enable_ramping: false, enabled: true,
    end_depth: sheet.depth.toFixed(3), name, ramp_angle: 20,
    speeds: { feedrate: speeds.feed, plungerate: speeds.plunge, rpm: speeds.rpm },
    start_depth: '0.000', stepdown: speeds.stepdown, stepover: 1.5875, stock_to_leave: 0, tolerance: 0.01,
    tool: toolFor(speeds), toolpath_group: group, toolpath_layers: [], version: 1
  });
  // Tabs: their height is measured up from the bottom of the cut.
  const tabHeight = Math.round((sheet.tabTop + sheet.depth) * 1000) / 1000;
  let count = 0;
  if (groups.pocket.length) {
    const id = uuid();
    add(id, 'pocket_toolpath', 'toolpath', { ...common('Holes (pocket)', groups.pocket), angle: 0, enable_rest: false, rest_diameter: 3.175, type: 'pocket_toolpath', uuid: id });
    count++;
  }
  const contour = (name, elements, dir, tabWidth) => {
    const id = uuid();
    add(id, 'contour', 'toolpath', {
      ...common(name, elements), climb: !!sheet.climb, ignore_tabs: false, ofset_dir: dir,
      tab_height: tabHeight, tab_width: tabWidth, type: 'contour', uuid: id
    });
    count++;
  };
  if (groups.inside.length) contour('Openings (inside)', groups.inside, -1, 4);
  contour('Outside profile (last)', groups.outside, 1, 6);

  // The empty 3D model: a grid of about a million cells over the stock.
  const cell0 = Math.sqrt((sheet.W * sheet.H) / 1e6);
  const cols = Math.ceil(sheet.W / cell0), cell = sheet.W / cols, rowsN = Math.floor(sheet.H / cell);
  const model = Buffer.alloc(52);
  model.writeBigInt64LE(2n, 0); model.writeDoubleLE(cell, 8); model.writeDoubleLE(1, 16);
  model.writeDoubleLE(0, 24); model.writeDoubleLE(0, 32);
  model.writeInt32LE(cols, 40); model.writeInt32LE(rowsN, 44); model.writeInt32LE(0, 48);
  const modelData = pack(model);
  rows.push(['MODEL', '', 'model', 'model_2', modelData.length, modelData]); // (sz as in the specimens)

  const params = {
    num_toolpaths: count, minimum_carbide_motion_version: 565, requires_pro: 0, active_layer: '', version: 100,
    build_num: 853, minimum_build_num: 810, width: sheet.W, height: sheet.H, thickness: sheet.depth,
    display_mm: 0, grid_enabled: 1, grid_spacing: 5.0, zero_z: 0.0, zero_x: 0.0, zero_y: 0.0,
    material: 'Aluminum', machine: 'Shapeoko 5 Pro', machine_type: 'Shapeoko', retract: 1.27,
    tiling_enabled: 0, tile_margin_x: 25.4, tile_overlap_y: 12.7, tile_height: 508.0, tile_current_index: 0,
    background_visible: 0, background_rotation: 0.0, background_scale: 1.0, background_position_x: 0.0,
    background_position_y: 0.0, background_opacity: 0.5, show_notes: 1
  };
  // Lengths as Carbide writes them, with a decimal point (5.0, not 5).
  const decimals = new Set(['width', 'height', 'thickness', 'grid_spacing', 'zero_z', 'zero_x', 'zero_y', 'retract', 'tile_margin_x', 'tile_overlap_y', 'tile_height', 'background_rotation', 'background_scale', 'background_position_x', 'background_position_y', 'background_opacity']);
  const text = (k, v) => (decimals.has(k) ? (Number.isInteger(v) ? v.toFixed(1) : String(mm(v))) : String(v));

  const svg = previewSvg(sheet), svgPacked = pack(svg);
  const note = Buffer.from(notes, 'utf8');
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const file = path.join(os.tmpdir(), `cam-${crypto.randomBytes(8).toString('hex')}.c2d`);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA page_size = 4096');
    db.exec('PRAGMA journal_mode = DELETE');
    for (const sql of SCHEMA) db.exec(sql);
    db.exec('BEGIN');
    const putParam = db.prepare('INSERT INTO params(key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(params)) putParam.run(k, text(k, v));
    const putItem = db.prepare('INSERT INTO items(uuid, name, type, version, sz, data) VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of rows) putItem.run(...r);
    const putFile = db.prepare('INSERT INTO sqlar(name, mode, mtime, sz, data) VALUES (?, 33188, ?, ?, ?)');
    putFile.run('background.png', stamp, 0, null);
    putFile.run('all.svg', stamp, svg.length, svgPacked);
    putFile.run('preview.svg', stamp, svg.length, svgPacked);
    putFile.run('notes.txt', stamp, note.length, note);
    const debug = Buffer.from('Made by the CrackBotics website\n');
    putFile.run('debug.txt', stamp, debug.length, debug);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  try {
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}
