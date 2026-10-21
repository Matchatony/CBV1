import ClipperLib from 'clipper-lib';
import { MM_PER_IN, minRect } from '../../step-measure.js';
import { dxfProfile } from './dxf.js';

// Toolpaths for the shop's Shapeoko 5 Pro, made from a customer's plate file
// (the admin panel's Toolpath panel, api/cam.js). A plate (STEP or DXF) is
// reduced to its 2D profile: the outline plus the through holes and cutouts.
// Copies are nested on one sheet, every feature gets its operation, and the
// sheet becomes one G-code program (inches, for gSender) plus the same layout
// as a Carbide Create project (api/_lib/c2d.js). The shop's CAM spec:
//   - 1/8 in. flat end mill, 16,000 RPM, 20 ipm cut, 10 ipm plunge, at most
//     0.025 in. a pass, cut through to the stock thickness + 0.254 mm;
//   - holes and slots up to 1/2 in. wide cleared with concentric rings (no
//     slug), bigger openings cut on the inside with the slug held by 3 tabs,
//     the outside of every plate cut last, tabbed; anything narrower than the
//     tool is skipped and listed, never dropped silently;
//   - copies 8 mm apart, 5 mm in from the sheet's edges, zero at the stock's
//     lower-left corner on top, Z up.

export const CAM = {
  machine: 'Shapeoko 5 Pro',
  bed: [609.6, 609.6],          // the shop's 2x2: about 24 x 24 in. of cutting area
  tool: 3.175,                  // 1/8 in. flat end mill
  rpm: 16000, feedIpm: 20, plungeIpm: 10, stepdownIn: 0.025,
  overcut: 0.254,               // below the stock, into the spoilboard
  tabThick: 0.5,                // tab material left above the stock's bottom
  retractIn: 0.05,              // above the stock between features
  margin: 5, gap: 8,            // around the sheet, between copies
  pocketMax: 12.7,              // holes and slots up to this wide are cleared in rings
  stepover: 0.5,                // of the tool, between rings
  innerTabs: 3, innerTabWidth: 4,
  outerTabWidth: 6, outerTabEvery: 90, outerTabsMin: 4,
  pauseEveryIn: 6, pauseSec: 2, startDwellSec: 3,
  chord: 0.005                  // curves are followed within this (mm)
};

export class CamError extends Error {}

const R = CAM.tool / 2;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const inch = (mm) => mm / MM_PER_IN;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const ascii = (s) => String(s || '').replace(/[()]/g, (c) => (c === '(' ? '[' : ']')).replace(/[^\x20-\x7e]/g, '').trim();

// ---- 2D geometry ----

// Positive for a counterclockwise loop (Y up).
function area(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2;
}
const ccw = (pts, want = true) => ((area(pts) > 0) === want ? pts : pts.slice().reverse());
const loopLength = (pts) => pts.reduce((s, p, i) => s + dist(p, pts[(i + 1) % pts.length]), 0);
function bbox(loops) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const l of loops) for (const [x, y] of l) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  return b;
}
function circlePts(c, r, tol = CAM.chord) {
  const n = Math.max(12, Math.ceil((2 * Math.PI) / (2 * Math.acos(Math.max(-1, 1 - tol / r)))));
  return Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)]);
}
function insidePoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Drops points that sit within tol of the straight line past them (closed loop).
function simplify(pts, tol = 0.001) {
  if (pts.length < 8) return pts;
  // Split at the point farthest from the first, then thin each half.
  let far = 0;
  pts.forEach((p, i) => { if (dist(p, pts[0]) > dist(pts[far], pts[0])) far = i; });
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[far] = 1;
  const stack = [[0, far], [far, pts.length]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b % pts.length];
    const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1e-12;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - A[0]) * dy - (pts[i][1] - A[1]) * dx) / L;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Clipper (integer coordinates: 0.1 micron) for offsets and area checks.
const S = 1e4;
const toC = (pts) => pts.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) }));
const fromC = (path) => path.map((p) => [p.X / S, p.Y / S]);
const { JoinType, EndType, ClipType, PolyType, PolyFillType } = ClipperLib;
function offset(loops, delta, end = EndType.etClosedPolygon) {
  const co = new ClipperLib.ClipperOffset(2, 0.002 * S);
  co.AddPaths(loops.map(toC), JoinType.jtRound, end);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta * S);
  return out.map(fromC).filter((l) => l.length >= 3);
}
function boolean(type, subject, clip) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject.map(toC), PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip.map(toC), PolyType.ptClip, true);
  const out = new ClipperLib.Paths();
  c.Execute(type, out, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return out.map(fromC);
}
const netArea = (loops) => loops.reduce((s, l) => s + area(l), 0);
// Whatever is wider than 2 x w somewhere (a thin sliver disappears).
const hasBody = (loops, w) => offset(loops, -w).some((l) => Math.abs(area(l)) > 1e-4);

// ---- Parts from the files ----

// A part: { outlines: [loop], holes: [{ pts, circle: { c, r } | null }],
// pockets: [{ at, diameter, depth, area }], thickness (model, mm) | null,
// mirror, warnings, assumptions }. Loops are [[x, y], ...] in mm.

// One measured STEP solid (step-measure.js, read with { tol, profile }).
export function stepPart(m) {
  if (!m.contours) throw new CamError('This solid has no flat faces, so it isn\'t a plate.');
  const outline = m.contours.find((x) => x.type === 'outline');
  if (!outline) throw new CamError('Couldn\'t find the plate\'s outline in the model.');
  const warnings = [], assumptions = [];
  let outer = outline.pts;
  let holes = m.contours.filter((x) => x.type === 'hole' || x.type === 'cutout')
    .map((x) => ({ pts: x.pts, circle: x.center && x.diameter ? { c: x.center, r: x.diameter / 2 } : null }));
  const pockets = m.contours.filter((x) => x.type === 'pocket').map((x) => ({
    at: x.center || x.pts.reduce((a, p) => [a[0] + p[0] / x.pts.length, a[1] + p[1] / x.pts.length], [0, 0]),
    diameter: x.diameter, depth: x.depth, area: x.area
  }));

  // Countersinks (and counterbores): a hole bigger on one face than the
  // other. The neck (the smaller size) is what goes through.
  let onTop = 0, onBottom = 0;
  const prof = m.profile;
  if (prof && prof.bottom) {
    const under = prof.bottom.filter((l) => l.area < 0 && l.circle);
    for (const h of holes) {
      if (!h.circle) continue;
      const b = under.find((l) => dist(l.circle.center, h.circle.c) < 0.02);
      if (!b) continue;
      if (b.circle.r < h.circle.r - 0.005) { h.face = h.circle.r; h.circle = { c: h.circle.c, r: b.circle.r }; h.pts = null; onTop++; }
      else if (b.circle.r > h.circle.r + 0.005) { h.face = b.circle.r; onBottom++; }
    }
    // A bigger outline underneath (a chamfer or fillet around the top edge):
    // cut the full size.
    const bOuter = prof.bottom.filter((l) => l.area > 0).reduce((x, y) => (!x || y.area > x.area ? y : x), null);
    if (bOuter && bOuter.area > Math.abs(area(outer)) + 0.5) {
      outer = bOuter.pts;
      warnings.push('The bottom face\'s outline is bigger than the top\'s (a chamfer or rounded top edge): the outside is cut at the bottom\'s full size and the edge shape isn\'t cut.');
    }
  } else if (m.flags && m.flags.some((f) => f.id === 'sloped')) {
    warnings.push('The model was read from a mesh, so countersinks weren\'t checked: holes are cut at their size on the top face.');
  }
  // A counterbore's through hole is listed twice (top face and floor): once is enough.
  holes = holes.filter((h, i) => !h.circle || !holes.slice(0, i).some((g) => g.circle && dist(g.circle.c, h.circle.c) < 0.02 && Math.abs(g.circle.r - h.circle.r) < 0.005));
  const mirror = onBottom > onTop;
  const sinks = mirror ? onBottom : onTop;
  if (sinks) {
    const sizes = [...new Set(holes.filter((h) => h.face).map((h) => `${r2(2 * h.circle.r)} mm (${r2(2 * h.face)} mm at the face)`))].slice(0, 6).join(', ');
    assumptions.push(`${sinks} hole(s) are bigger on one face (countersinks or counterbores): cut through at the smaller neck size, ${sizes}. The countersinks themselves aren't cut.`);
    assumptions.push(mirror
      ? 'The countersinks are on the model\'s bottom face, so the part is mirrored (flipped over) to put that face up.'
      : 'The countersink face is up as drawn (no mirroring).');
    if (onTop && onBottom) warnings.push(`Countersinks on both faces: ${onTop} on one, ${onBottom} on the other. The face with more is up; the other ${Math.min(onTop, onBottom)} will be on the bottom.`);
  }
  for (const f of m.flags || []) {
    if (f.id === 'small_holes' || f.id === 'no_outline') continue; // listed as skipped features below / thrown above
    if (f.id === 'sloped' && sinks) continue;
    if (f.id === 'both_sides') warnings.push('The model has features cut into its bottom face (pockets from below). They aren\'t in this toolpath.');
    else if (f.id === 'edge_step') warnings.push('The model has a step around its outside edge. Only the through cut is in this toolpath.');
    else warnings.push(f.text);
  }
  return { outlines: [outer], holes, pockets, thickness: m.thickness, mirror, warnings, assumptions };
}

export function dxfPart(text) {
  const p = dxfProfile(text, { tol: CAM.chord });
  if (!p || !p.outlines.length) throw new CamError(`No closed outline in this DXF${p && p.open ? ` (${p.open} shape(s) aren't closed loops)` : ''}.`);
  const warnings = [], assumptions = [];
  if (p.guessed) assumptions.push(`The DXF doesn't say its units: read as ${p.units === 'mm' ? 'millimeters' : 'inches'} from its size, the same way the quote page does.`);
  if (p.open) warnings.push(`${p.open} shape(s) in the DXF aren't closed loops (loose lines or arcs): they're left out. Check the drawing.`);
  if (p.outlines.length > 1) assumptions.push(`The drawing has ${p.outlines.length} separate outlines: each copy cuts all of them, as drawn.`);
  return {
    outlines: p.outlines.map((l) => l.pts), holes: p.holes.map((l) => ({ pts: l.pts, circle: l.circle ? { c: l.circle.c, r: l.circle.r } : null })),
    pockets: [], thickness: null, mirror: false, warnings, assumptions
  };
}

// ---- Toolpath rings ----

// A ring is a closed tool-center path in the cutting direction: a polygon
// (pts, cum = distance along it to each point, L) or a circle (c, rho, cw,
// a0 = start angle). Positions along it are distances from its start.
function polyRing(pts) {
  const cum = [0];
  for (let i = 1; i <= pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i % pts.length]));
  return { kind: 'poly', pts, cum, L: cum[pts.length] };
}
const circleRing = (c, rho, cw, a0 = 0) => ({ kind: 'circle', c, rho, cw, a0, L: 2 * Math.PI * rho });
function pointAt(ring, s) {
  if (ring.kind === 'circle') {
    const a = ring.a0 + ((ring.cw ? -1 : 1) * s) / ring.rho;
    return [ring.c[0] + ring.rho * Math.cos(a), ring.c[1] + ring.rho * Math.sin(a)];
  }
  const { pts, cum } = ring;
  let lo = 0, hi = pts.length;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const a = pts[lo], b = pts[(lo + 1) % pts.length], t = (s - cum[lo]) / ((cum[lo + 1] - cum[lo]) || 1);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
// The same polygon ring starting at point i.
function startAt(ring, i) {
  if (!i) return ring;
  return polyRing(ring.pts.slice(i).concat(ring.pts.slice(0, i)));
}

// Tabs on a ring: n intervals [from, to] of the tool center's path, each the
// tab's width plus the tool's diameter long, spread evenly and slid onto the
// straightest stretch nearby (a tab across a corner is hard to clean up).
function placeTabs(ring, n, width) {
  const span = width + CAM.tool;
  while (n > 0 && n * (span + 1) > 0.9 * ring.L) n--;
  if (!n) return [];
  if (ring.kind === 'circle') return Array.from({ length: n }, (_, i) => { const c = ((i + 0.5) * ring.L) / n; return [c - span / 2, c + span / 2]; });
  const { pts, cum } = ring, N = pts.length;
  // Turning at each point, summed along the ring.
  const turn = [0];
  for (let i = 0; i < N; i++) {
    const a = pts[(i + N - 1) % N], b = pts[i], c = pts[(i + 1) % N];
    const t = Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
    turn.push(turn[i] + t);
  }
  const idx = (s) => { let lo = 0, hi = N; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; } return lo; };
  const turning = (a, b) => turn[idx(b) + 1] - turn[idx(a) + 1];
  const tabs = [];
  const step = ring.L / n, room = step / 3;
  for (let i = 0; i < n; i++) {
    const ideal = (i + 0.5) * step;
    let best = null;
    for (let d = -room; d <= room; d += Math.max(0.5, room / 40)) {
      const c = ideal + d, a = c - span / 2, b = c + span / 2;
      if (a < 1 || b > ring.L - 1) continue;
      const score = turning(a, b) + 0.002 * Math.abs(d);
      if (!best || score < best.score) best = { score, a, b };
    }
    if (best) tabs.push([best.a, best.b]);
  }
  return tabs;
}

// ---- G-code ----

// Inches, 4 decimals, trailing zeros dropped.
function num(mm) {
  let s = (mm / MM_PER_IN).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

class Program {
  constructor() {
    this.lines = [];
    this.x = null; this.y = null; this.z = Infinity; this.feed = null;
    this.sx = ''; this.sy = '';
    this.mm = { cut: 0, plunge: 0, rapidXY: 0, rapidZ: 0 };
    this.sec = 0; this.pauses = 0; this.zMin = Infinity;
    this.box = [Infinity, Infinity, -Infinity, -Infinity];
  }
  see(x, y, pad = 0) { const b = this.box; b[0] = Math.min(b[0], x - pad); b[1] = Math.min(b[1], y - pad); b[2] = Math.max(b[2], x + pad); b[3] = Math.max(b[3], y + pad); }
  rapidZ(z) {
    if (z === this.z) return;
    this.lines.push(`G0 Z${num(z)}`);
    if (Number.isFinite(this.z)) this.mm.rapidZ += Math.abs(z - this.z);
    this.z = z;
  }
  rapidXY(x, y) {
    const sx = num(x), sy = num(y);
    if (sx === this.sx && sy === this.sy) return;
    this.lines.push(`G0 X${sx} Y${sy}`);
    if (this.x !== null) this.mm.rapidXY += Math.hypot(x - this.x, y - this.y);
    this.x = x; this.y = y; this.sx = sx; this.sy = sy;
    this.see(x, y, R);
  }
  // Straight down (or up, onto a tab) at the plunge rate.
  plunge(z) {
    if (num(z) === num(this.z)) { this.z = z; return; }
    this.lines.push(`G1 Z${num(z)} F${CAM.plungeIpm}`);
    this.feed = CAM.plungeIpm;
    this.mm.plunge += Math.abs(z - this.z);
    this.z = z; this.zMin = Math.min(this.zMin, z);
  }
  f() { if (this.feed === CAM.feedIpm) return ''; this.feed = CAM.feedIpm; return ` F${CAM.feedIpm}`; }
  cut(x, y) {
    const sx = num(x), sy = num(y);
    if (sx === this.sx && sy === this.sy) return;
    this.lines.push(`G1 X${sx} Y${sy}${this.f()}`);
    this.mm.cut += Math.hypot(x - this.x, y - this.y);
    this.x = x; this.y = y; this.sx = sx; this.sy = sy;
    this.zMin = Math.min(this.zMin, this.z);
    this.see(x, y, R);
  }
  arc(cw, x, y, c, sweep, rho) {
    const sx = num(x), sy = num(y);
    // Same start and end would be a full circle: a sliver of an arc is skipped.
    if (sx === this.sx && sy === this.sy) return;
    // I and J from the rounded start, so the controller sees the same radius at both ends.
    const i = num(c[0] - Number(this.sx) * MM_PER_IN), j = num(c[1] - Number(this.sy) * MM_PER_IN);
    this.lines.push(`${cw ? 'G2' : 'G3'} X${sx} Y${sy} I${i} J${j}${this.f()}`);
    this.mm.cut += sweep * rho;
    this.x = x; this.y = y; this.sx = sx; this.sy = sy;
    this.zMin = Math.min(this.zMin, this.z);
    this.see(c[0], c[1], rho + R);
  }
  dwell(sec) { this.lines.push(`G4 P${sec}`); this.sec += sec; }
}

// Along a ring from s0 to s1 (shifted by off), cutting.
function follow(prog, ring, s0, s1, off) {
  if (s1 - s0 < 1e-9) return;
  if (ring.kind === 'circle') {
    const sweep = (s1 - s0) / ring.rho, k = Math.ceil(sweep / Math.PI - 1e-9);
    const c = [ring.c[0] + off[0], ring.c[1] + off[1]];
    for (let i = 1; i <= k; i++) {
      const p = pointAt(ring, s0 + ((s1 - s0) * i) / k);
      prog.arc(ring.cw, p[0] + off[0], p[1] + off[1], c, sweep / k, ring.rho);
    }
    return;
  }
  const { pts, cum } = ring;
  for (let i = 1; i < pts.length; i++) if (cum[i] > s0 + 1e-9 && cum[i] < s1 - 1e-9) prog.cut(pts[i][0] + off[0], pts[i][1] + off[1]);
  const p = s1 >= ring.L - 1e-9 ? pts[0] : pointAt(ring, s1);
  prog.cut(p[0] + off[0], p[1] + off[1]);
}

// One lap of a ring at depth z, already at its start. Tabs (when this pass is
// below their top) are crossed at the tab top. Every 6 in. of cutting the bit
// lifts to liftZ, waits and plunges back, so the router gets its speed back.
// run: cutting since the last plunge or pause; returns the new value.
function lap(prog, ring, off, z, liftZ, tabs, tabTop, run) {
  const PAUSE = CAM.pauseEveryIn * MM_PER_IN, TAIL = 6;
  const active = z < tabTop - 1e-9 ? tabs : [];
  let s = 0, ti = 0;
  while (s < ring.L - 1e-9) {
    const tab = active[ti];
    if (tab && s >= tab[0] - 1e-9) {
      prog.plunge(tabTop);
      follow(prog, ring, s, tab[1], off);
      prog.plunge(z);
      run += tab[1] - s; s = tab[1]; ti++;
      continue;
    }
    if (run >= PAUSE - 1e-9 && ring.L - s > TAIL) {
      prog.rapidZ(liftZ); prog.dwell(CAM.pauseSec); prog.plunge(z);
      prog.pauses++; run = 0;
    }
    const stop = Math.min(tab ? tab[0] : ring.L, run >= PAUSE ? ring.L : s + PAUSE - run);
    follow(prog, ring, s, stop, off);
    run += stop - s; s = stop;
  }
  return run;
}

// Whether the straight move a-b stays inside the loops (no wall crossed).
function segmentInside(a, b, loops) {
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (loops.filter((l) => insidePoly(mid, l)).length % 2 === 0) return false;
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  for (const l of loops) for (let i = 0; i < l.length; i++) {
    const c = l[i], d = l[(i + 1) % l.length];
    const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
    if (((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))) return false;
  }
  return true;
}

// ---- Planning ----

const rotate = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];

// part (stepPart / dxfPart) on a sheet: settings { thickness (mm), qty,
// climb, name, material, version }. Returns the G-code, the layout for the
// .c2d, a picture (SVG) and the report.
export function planSheet(part, settings) {
  const T = settings.thickness, qty = settings.qty, climb = !!settings.climb;
  if (!(T > 0 && T <= 25.4)) throw new CamError('Stock thickness must be between 0 and 25.4 mm (1 in.).');
  if (!(Number.isInteger(qty) && qty >= 1 && qty <= 200)) throw new CamError('Quantity must be a whole number from 1 to 200.');
  const warnings = [...part.warnings], assumptions = [...part.assumptions];

  // Lay the part's long side along X (smallest box), mirrored if its
  // countersinks are on the bottom.
  const turn = minRect(part.outlines.flat()).angle;
  let tf = (p) => { const q = rotate(p, -turn); return part.mirror ? [-q[0], q[1]] : q; };

  // Copies in a grid: the arrangement (part turned 0 or 90 degrees) that
  // needs the least stock, preferring one that fits the bed.
  const b0 = bbox(part.outlines.map((l) => l.map(tf)));
  const size = [b0[2] - b0[0], b0[3] - b0[1]];
  let layout = null;
  for (const rot of [0, 1]) {
    const [w, h] = rot ? [size[1], size[0]] : size;
    for (let cols = 1; cols <= qty; cols++) {
      const rows = Math.ceil(qty / cols);
      if ((cols - 1) * rows >= qty) continue;
      const W = 2 * CAM.margin + cols * w + (cols - 1) * CAM.gap, H = 2 * CAM.margin + rows * h + (rows - 1) * CAM.gap;
      const fits = (W <= CAM.bed[0] && H <= CAM.bed[1]);
      const score = [fits ? 0 : 1, W * H, Math.max(W, H)];
      if (!layout || score[0] < layout.score[0] || (score[0] === layout.score[0] && (score[1] < layout.score[1] - 1e-6 || (Math.abs(score[1] - layout.score[1]) <= 1e-6 && score[2] < layout.score[2])))) {
        layout = { rot, cols, rows, w, h, W, H, fits, score };
      }
    }
  }
  if (layout.rot) { const before = tf; tf = (p) => { const q = before(p); return [-q[1], q[0]]; }; }
  const b1 = bbox(part.outlines.map((l) => l.map(tf)));
  const place = (p) => { const q = tf(p); return [q[0] - b1[0], q[1] - b1[1]]; };
  if (!layout.fits) warnings.push(`The sheet (${r1(inch(layout.W))} x ${r1(inch(layout.H))} in.) is bigger than the ${r1(inch(CAM.bed[0]))} x ${r1(inch(CAM.bed[1]))} in. bed: cut fewer copies per sheet.`);

  // The part in place (copy 1's own frame, lower-left at 0, 0).
  const outlines = part.outlines.map((l) => ccw(simplify(l.map(place))));
  const holes = part.holes.map((h) => {
    const circle = h.circle ? { c: place(h.circle.c), r: h.circle.r } : null;
    return { circle, pts: circle ? circlePts(circle.c, circle.r) : ccw(simplify(h.pts.map(place))), face: h.face || null };
  });
  const pockets = part.pockets.map((p) => ({ ...p, at: place(p.at) }));

  // Passes: equal steps, none deeper than 0.025 in.
  const depth = T + CAM.overcut;
  const passes = Math.ceil(depth / (CAM.stepdownIn * MM_PER_IN) - 1e-9);
  const zs = Array.from({ length: passes }, (_, k) => (-depth * (k + 1)) / passes);
  const tabTop = -T + CAM.tabThick;
  const retract = CAM.retractIn * MM_PER_IN;
  const step = CAM.stepover * CAM.tool;
  const insideCw = !climb, outsideCw = climb;

  // Each feature's operation.
  const features = [], skipped = [];
  const where = (p) => `at X ${r2(inch(p[0] + CAM.margin))}, Y ${r2(inch(p[1] + CAM.margin))} in.`;
  holes.forEach((h, hi) => {
    if (h.circle) {
      const d = 2 * h.circle.r;
      if (d < CAM.tool - 1e-6) {
        h.op = 'skip';
        skipped.push({ hole: hi, text: `Hole Ø${r2(d)} mm (${r3(inch(d))} in.) ${where(h.circle.c)}: smaller than the 1/8 in. bit, needs a 1/16 in. bit (or drill it)` });
        return;
      }
      const rho = h.circle.r - R;
      if (d <= CAM.pocketMax + 1e-6) {
        h.op = 'pocket';
        const rings = [rho];
        while (rings[rings.length - 1] > R + 1e-9) rings.push(Math.max(0, rings[rings.length - 1] - step));
        features.push({ op: 'pocket', hole: hi, kind: 'circle', c: h.circle.c, rings: rings.reverse(), at: h.circle.c });
      } else {
        h.op = 'inside';
        const ring = circleRing(h.circle.c, rho, insideCw);
        features.push({ op: 'inside', hole: hi, ring, tabs: placeTabs(ring, CAM.innerTabs, CAM.innerTabWidth), at: h.circle.c });
      }
      return;
    }
    const centers = offset([h.pts], -R).filter((l) => area(l) > 1e-4);
    const width = minRect(h.pts).width;
    const mid = (() => { const b = bbox([h.pts]); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; })();
    if (!centers.length) {
      h.op = 'skip';
      skipped.push({ hole: hi, text: `Opening ${r2(width)} mm (${r3(inch(width))} in.) wide ${where(mid)}: narrower than the 1/8 in. bit, needs a 1/16 in. bit` });
      return;
    }
    // Parts of the opening the bit can't reach (narrow ends, a waist).
    const reach = offset(centers, R);
    const left = boolean(ClipType.ctDifference, [h.pts], reach);
    if (hasBody(left, 0.3)) {
      skipped.push({ hole: hi, partial: true, text: `Opening ${where(mid)}: about ${r1(Math.abs(netArea(left)))} mm² of it is narrower than the 1/8 in. bit and stays uncut (needs a 1/16 in. bit)` });
    }
    if (width <= CAM.pocketMax + 1e-6) {
      h.op = 'pocket';
      // Rings inward from the wall, half a bit apart, until nothing is left
      // (one more half step catches a thin middle).
      const levels = [centers];
      for (let k = 1; k < 200; k++) {
        let next = offset([h.pts], -(R + k * step)).filter((l) => area(l) > 1e-4);
        if (!next.length) {
          next = offset([h.pts], -(R + (k - 0.5) * step)).filter((l) => area(l) > 1e-4);
          if (next.length) levels.push(next);
          break;
        }
        levels.push(next);
      }
      const rings = levels.reverse().map((ls) => ls.map((l) => polyRing(ccw(simplify(l), !insideCw))));
      features.push({ op: 'pocket', hole: hi, kind: 'poly', levels: rings, region: centers, at: mid });
    } else {
      h.op = 'inside';
      for (const l of centers) {
        const ring = polyRing(ccw(simplify(l), !insideCw));
        features.push({ op: 'inside', hole: hi, ring, tabs: placeTabs(ring, CAM.innerTabs, CAM.innerTabWidth), at: mid });
      }
    }
  });
  outlines.forEach((o, oi) => {
    const around = offset([o], R).filter((l) => area(l) > 0);
    if (!around.length) throw new CamError('The outline is too small to cut around.');
    const path = around.reduce((x, y) => (area(y) > area(x) ? y : x));
    // Notches in the outline narrower than the bit stay filled.
    const filled = boolean(ClipType.ctDifference, offset([path], -R), [o]);
    if (hasBody(filled, 0.3)) {
      const b = bbox(filled);
      skipped.push({ outline: oi, partial: true, text: `Notch in the outline ${where([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2])}: about ${r1(Math.abs(netArea(filled)))} mm² narrower than the 1/8 in. bit stays (needs a 1/16 in. bit)` });
    }
    const ring = polyRing(ccw(simplify(path), !outsideCw));
    const n = Math.max(CAM.outerTabsMin, Math.round(loopLength(o) / CAM.outerTabEvery));
    const tabs = placeTabs(ring, n, CAM.outerTabWidth);
    if (tabs.length < n) warnings.push(tabs.length ? `Only ${tabs.length} tabs fit around the outline.` : 'The outline is too short for tabs: hold the part down another way.');
    const b = bbox([o]);
    features.push({ op: 'outside', outline: oi, ring, tabs, at: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] });
  });
  for (const p of pockets) {
    skipped.push({ pocket: true, text: `Blind pocket${p.diameter ? ` Ø${r2(p.diameter)} mm` : ''}, ${r2(p.depth)} mm deep ${where(p.at)}: not cut (through cuts only)` });
  }

  // Copies on the sheet.
  const offsets = Array.from({ length: qty }, (_, i) => [
    CAM.margin + (i % layout.cols) * (layout.w + CAM.gap), CAM.margin + Math.floor(i / layout.cols) * (layout.h + CAM.gap)
  ]);

  // ---- The program ----
  const prog = new Program();
  const name = ascii(settings.name) || 'part';
  const material = ascii(settings.material) || '6061 aluminum';
  const passMm = depth / passes;
  const counts = { pocket: 0, inside: 0, outside: 0 };
  for (const f of features) counts[f.op]++;
  const skipCount = skipped.filter((x) => !x.partial && !x.pocket).length;

  let pos = [0, 0];
  const order = [];
  for (const op of ['pocket', 'inside', 'outside']) {
    const left = [];
    for (const off of offsets) for (const f of features) if (f.op === op) left.push({ f, off, at: [f.at[0] + off[0], f.at[1] + off[1]] });
    // Nearest neighbor.
    while (left.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < left.length; i++) { const d = (left[i].at[0] - pos[0]) ** 2 + (left[i].at[1] - pos[1]) ** 2; if (d < bd) { bd = d; bi = i; } }
      const item = left[bi];
      left[bi] = left[left.length - 1]; left.pop();
      pos = cutFeature(item.f, item.off, pos);
      order.push(item);
    }
  }

  // Each feature, all passes, from pos; returns where it ends.
  function cutFeature(f, off, from) {
    const lift = (k) => (k ? zs[k - 1] : retract);
    const enter = (p) => { prog.rapidXY(p[0], p[1]); prog.rapidZ(retract); };
    if (f.kind === 'circle') {
      const c = [f.c[0] + off[0], f.c[1] + off[1]];
      const a0 = Math.atan2(from[1] - c[1], from[0] - c[0]) || 0;
      const rings = f.rings.map((rho) => circleRing(f.c, rho, insideCw, a0));
      const startOf = (ring) => { const p = pointAt(ring, 0); return [p[0] + off[0], p[1] + off[1]]; };
      const first = rings[0].rho > 0.02 ? startOf(rings[0]) : c;
      enter(first);
      zs.forEach((z, k) => {
        if (k) prog.cut(first[0], first[1]);
        prog.plunge(z);
        let run = 0;
        rings.forEach((ring, i) => {
          if (ring.rho <= 0.02) return;
          if (i) { const p = startOf(ring); prog.cut(p[0], p[1]); }
          run = lap(prog, ring, off, z, lift(k), [], 0, run);
        });
      });
      prog.rapidZ(retract);
      return [prog.x, prog.y];
    }
    if (f.kind === 'poly') {
      // Innermost rings first, each starting at its point nearest the last.
      let at = [from[0] - off[0], from[1] - off[1]];
      const seq = [];
      for (const level of f.levels) {
        const rest = level.slice();
        while (rest.length) {
          let best = null;
          rest.forEach((ring, ri) => ring.pts.forEach((p, pi) => { const d = dist(p, at); if (!best || d < best.d) best = { d, ri, pi }; }));
          const ring = startAt(rest[best.ri], best.pi);
          rest.splice(best.ri, 1);
          seq.push(ring);
          at = ring.pts[0];
        }
      }
      const abs = (p) => [p[0] + off[0], p[1] + off[1]];
      enter(abs(seq[0].pts[0]));
      zs.forEach((z, k) => {
        if (k) {
          // Back to the first ring across the cleared floor, or over the top.
          if (segmentInside([prog.x - off[0], prog.y - off[1]], seq[0].pts[0], f.region)) prog.cut(...abs(seq[0].pts[0]));
          else { prog.rapidZ(retract); prog.rapidXY(...abs(seq[0].pts[0])); }
        }
        prog.plunge(z);
        let run = 0;
        seq.forEach((ring, i) => {
          if (i) {
            const p = ring.pts[0];
            if (segmentInside([prog.x - off[0], prog.y - off[1]], p, f.region)) prog.cut(...abs(p));
            else { prog.rapidZ(retract); prog.rapidXY(...abs(p)); prog.plunge(z); run = 0; }
          }
          run = lap(prog, ring, off, z, lift(k), [], 0, run);
        });
      });
      prog.rapidZ(retract);
      return [prog.x, prog.y];
    }
    // A contour: start at its point nearest the bit, clear of the tabs.
    let ring = f.ring, tabs = f.tabs;
    const local = [from[0] - off[0], from[1] - off[1]];
    if (ring.kind === 'circle') {
      ring = circleRing(ring.c, ring.rho, ring.cw, Math.atan2(local[1] - ring.c[1], local[0] - ring.c[0]) || 0);
    } else {
      const clear = (s) => !tabs.some(([a, b]) => s > a - 1 && s < b + 1);
      let bi = 0, bd = Infinity;
      ring.pts.forEach((p, i) => { const d = dist(p, local); if (d < bd && clear(ring.cum[i])) { bd = d; bi = i; } });
      const s0 = ring.cum[bi];
      tabs = tabs.map(([a, b]) => [(a - s0 + ring.L) % ring.L, (b - s0 + ring.L) % ring.L]).map(([a, b]) => (b < a ? [a, b + ring.L] : [a, b])).sort((x, y) => x[0] - y[0]);
      ring = startAt(ring, bi);
    }
    const start = pointAt(ring, 0);
    enter([start[0] + off[0], start[1] + off[1]]);
    zs.forEach((z, k) => {
      prog.plunge(z);
      lap(prog, ring, off, z, lift(k), tabs, tabTop, 0);
    });
    prog.rapidZ(retract);
    return [prog.x, prog.y];
  }

  // ---- Checks ----
  const W = layout.W, H = layout.H;
  const problems = [];
  if (prog.zMin < -depth - 1e-6) problems.push(`Z goes to ${r3(prog.zMin)} mm, below the cut-through depth of -${r3(depth)} mm.`);
  const bx = prog.box;
  if (bx[0] < -1e-6 || bx[1] < -1e-6 || bx[2] > W + 1e-6 || bx[3] > H + 1e-6) problems.push(`The bit reaches outside the stock: X ${r2(bx[0])} to ${r2(bx[2])}, Y ${r2(bx[1])} to ${r2(bx[3])} mm on a ${r2(W)} x ${r2(H)} mm sheet.`);
  // What one copy comes out as, against the drawing.
  const drawing = boolean(ClipType.ctDifference, outlines, holes.map((h) => h.pts));
  let removed = [];
  for (const f of features) {
    if (f.op === 'outside') continue;
    if (f.kind === 'circle') removed.push(circlePts(f.c, f.rings[f.rings.length - 1] + R, 0.002));
    else if (f.kind === 'poly') removed.push(...offset(f.levels.flat().map((r) => r.pts), R, EndType.etClosedLine));
    else removed.push(...(f.ring.kind === 'circle' ? [circlePts(f.ring.c, f.ring.rho + R, 0.002)] : offset([f.ring.pts], R)));
  }
  removed = boolean(ClipType.ctUnion, removed, []);
  const kept = boolean(ClipType.ctDifference, features.filter((f) => f.op === 'outside').flatMap((f) => offset([f.ring.pts], -R)), removed);
  // (Curves are polygons a few microns apart in each, so slivers thinner
  // than 0.02 mm on average aren't counted as cut into the part.)
  const extra = boolean(ClipType.ctDifference, kept, drawing);
  const gouge = boolean(ClipType.ctDifference, drawing, kept).filter((l) => (2 * Math.abs(area(l))) / loopLength(l) > 0.02);
  const areas = { drawing: Math.abs(netArea(drawing)), cut: Math.abs(netArea(kept)), left: Math.abs(netArea(extra)), gouged: Math.abs(netArea(gouge)) };
  if (areas.gouged > 0.5) problems.push(`About ${r1(areas.gouged)} mm² of the part would be cut away: check the drawing.`);

  // Run time: cutting at 20 ipm, plunges at 10, rapids taken as 200 ipm
  // across and 60 ipm up and down, the dwells, plus 10% for slowing into
  // corners.
  const minutes = (inch(prog.mm.cut) / CAM.feedIpm) * 1.1 + inch(prog.mm.plunge) / CAM.plungeIpm +
    inch(prog.mm.rapidXY) / 200 + inch(prog.mm.rapidZ) / 60 + (prog.sec + CAM.startDwellSec) / 60;

  // ---- Report ----
  const modelT = part.thickness;
  if (modelT && Math.abs(modelT - T) > 0.05) {
    assumptions.unshift(`The model is ${r3(modelT)} mm (${r3(inch(modelT))} in.) thick; the stock is ${r3(T)} mm (${r3(inch(T))} in.). The stock thickness is used for every depth.`);
  } else if (modelT) {
    assumptions.unshift(`Thickness ${r3(T)} mm (${r3(inch(T))} in.), the same as the model.`);
  } else {
    assumptions.unshift(`Thickness ${r3(T)} mm (${r3(inch(T))} in.): a DXF has no thickness, so it's the stock's.`);
  }
  assumptions.push(`${qty} cop${qty === 1 ? 'y' : 'ies'} (the quantity set here, not a count of files).`);
  assumptions.push(climb
    ? 'Climb milling: outside cuts clockwise, inside cuts counterclockwise (the router spins clockwise).'
    : 'Outside cuts counterclockwise, inside cuts clockwise, as the spec says. With the router spinning clockwise (M3) that is conventional milling, not climb.');
  if (layout.rot) assumptions.push('Copies are turned 90 degrees from the part\'s long side, which needs less stock.');
  const outer = features.filter((f) => f.op === 'outside');
  const report = {
    part: name,
    stock: { w_mm: r1(W), h_mm: r1(H), t_mm: r3(T), w_in: r3(inch(W)), h_in: r3(inch(H)), t_in: r3(inch(T)) },
    copies: qty, layout: { cols: layout.cols, rows: layout.rows, turned: !!layout.rot, fits_bed: layout.fits },
    part_size_mm: [r1(layout.w), r1(layout.h)],
    model_thickness_mm: modelT ? r3(modelT) : null,
    depth_mm: r3(depth), passes, pass_mm: r3(passMm), tab_top_mm: r3(tabTop),
    operations: {
      pockets: counts.pocket * qty, inside_contours: counts.inside * qty, outside_contours: counts.outside * qty,
      tabs_per_outline: outer.length ? outer.map((f) => f.tabs.length) : [], tabs_per_slug: CAM.innerTabs
    },
    run_minutes: Math.round(minutes), pauses: prog.pauses,
    cut_length_m: r1((prog.mm.cut) / 1000),
    area_mm2: { drawing: r1(areas.drawing), cut: r1(areas.cut), left_on: r1(areas.left), cut_into_part: r1(areas.gouged) },
    skipped: skipped.map((x) => x.text), skipped_count_per_copy: skipCount,
    warnings, assumptions, problems,
    settings: {
      tool: '1/8 in. (3.175 mm) flat end mill', rpm: CAM.rpm, feed_ipm: CAM.feedIpm, plunge_ipm: CAM.plungeIpm,
      max_pass_in: CAM.stepdownIn, retract_in: CAM.retractIn, climb
    }
  };

  // Header comments, then the program.
  const head = [
    `(CrackBotics toolpath: ${name}${settings.version ? ` V${settings.version}` : ''})`,
    `(Part: ${name}, ${qty} cop${qty === 1 ? 'y' : 'ies'}, ${layout.cols} x ${layout.rows}${layout.rot ? ', turned 90 deg' : ''})`,
    `(Stock: ${r3(inch(W))} x ${r3(inch(H))} x ${r3(inch(T))} in = ${r1(W)} x ${r1(H)} x ${r3(T)} mm, ${material})`,
    '(Zero: lower-left corner of the stock, top surface, Z up)',
    '(Tool: 1/8 in = 3.175 mm flat end mill, no tool change)',
    `(Feeds: ${CAM.rpm} RPM, cut ${CAM.feedIpm} ipm, plunge ${CAM.plungeIpm} ipm, ${passes} passes of ${num(passMm)} in, ${climb ? 'climb: outside CW, inside CCW' : 'outside CCW, inside CW'})`,
    `(Cut-through depth: ${r3(inch(depth))} in = ${r3(depth)} mm. Tabs ${CAM.tabThick} mm thick, top at Z${num(tabTop)} in)`,
    `(Order: ${counts.pocket ? 'holes cleared in rings, ' : ''}${counts.inside ? 'openings cut inside with tabbed slugs, ' : ''}outside profiles last)`,
    `(Run time: about ${Math.round(minutes)} min. Every ${CAM.pauseEveryIn} in of cutting the bit lifts and waits ${CAM.pauseSec} s)`,
    ...skipped.map((x) => `(Skipped: ${ascii(x.text)})`),
    ...warnings.map((x) => `(Warning: ${ascii(x)})`),
    ...problems.map((x) => `(PROBLEM: ${ascii(x)})`)
  ];
  const start = ['G90 G94 G17 G20', 'G53 G0 Z0', `M3 S${CAM.rpm}`, `G4 P${CAM.startDwellSec}`, 'G54'];
  const end = [...(prog.z === retract ? [] : [`G0 Z${num(retract)}`]), 'G53 G0 Z0', 'M5', 'G53 G0 X0 Y0', 'M30'];
  const gcode = [...head, ...start, ...prog.lines, ...end].join('\n') + '\n';

  return {
    gcode, report,
    sheet: { W, H, T, depth, offsets, outlines, holes, climb, tabTop, passMm, name, material },
    svg: picture({ W, H, offsets, outlines, holes, order }),
    svg_cut: cutPicture({ W, H, offsets, features, holes }),
    svg_part: partPicture({ kept, holes })
  };
}

// ---- Picture ----

// Top view of the sheet: the parts (gray), holes cleared in rings (blue),
// openings cut inside (orange), outside cuts (green), tabs (red bars),
// skipped features (red dashes), and the moves between features (thin gray).
function picture({ W, H, offsets, outlines, holes, order }) {
  const y = (v) => r1(H - v);
  const d = (pts, off) => 'M' + pts.map((p) => `${r1(p[0] + off[0])} ${y(p[1] + off[1])}`).join('L') + 'Z';
  const round = ({ c, r }, off) => `M${r2(c[0] + off[0] - r)} ${r2(H - c[1] - off[1])}a${r2(r)} ${r2(r)} 0 1 0 ${r2(2 * r)} 0a${r2(r)} ${r2(r)} 0 1 0 ${r2(-2 * r)} 0Z`;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 ${r2(W + 16)} ${r2(H + 16)}" font-family="sans-serif">`);
  out.push(`<rect x="0" y="0" width="${r2(W)}" height="${r2(H)}" fill="#f1f2f4" stroke="#9aa0a6" stroke-width="0.4"/>`);
  for (const off of offsets) {
    const shape = [...outlines.map((l) => d(l, off)), ...holes.filter((h) => h.op !== 'skip').map((h) => (h.circle ? round(h.circle, off) : d(h.pts, off)))].join('');
    out.push(`<path d="${shape}" fill="#c9cdd3" fill-rule="evenodd" stroke="none"/>`);
    for (const h of holes.filter((x) => x.op === 'skip')) out.push(`<path d="${h.circle ? round(h.circle, off) : d(h.pts, off)}" fill="none" stroke="#dc2626" stroke-width="0.5" stroke-dasharray="1.2 0.8"/>`);
  }
  const color = { pocket: '#2563eb', inside: '#ea580c', outside: '#16a34a' };
  const ringD = (ring, off) => (ring.kind === 'circle' ? round({ c: ring.c, r: ring.rho }, off) : d(ring.pts, off));
  const moves = [];
  for (const { f, off } of order) {
    // (A round hole's outermost ring stands for all of them.)
    const rings = f.kind === 'circle' ? f.rings.slice(-1).filter((rho) => rho > 0.02).map((rho) => circleRing(f.c, rho, true))
      : f.kind === 'poly' ? f.levels.flat() : [f.ring];
    const path = rings.map((ring) => ringD(ring, off)).join('');
    if (path) out.push(`<path d="${path}" fill="none" stroke="${color[f.op]}" stroke-width="0.35"/>`);
    else out.push(`<circle cx="${r1(f.c[0] + off[0])}" cy="${y(f.c[1] + off[1])}" r="0.5" fill="${color[f.op]}"/>`);
    for (const [a, b] of f.tabs || []) {
      const pts = [];
      for (let s = a; s <= b + 1e-9; s += (b - a) / 8) pts.push(pointAt(f.ring, s));
      out.push(`<path d="M${pts.map((p) => `${r1(p[0] + off[0])} ${y(p[1] + off[1])}`).join('L')}" fill="none" stroke="#dc2626" stroke-width="1.1" stroke-linecap="round"/>`);
    }
    moves.push([f.at[0] + off[0], f.at[1] + off[1]]);
  }
  if (moves.length) out.push(`<path d="M0 ${y(0)}L${moves.map((p) => `${r1(p[0])} ${y(p[1])}`).join('L')}" fill="none" stroke="#6b7280" stroke-width="0.15" stroke-dasharray="0.8 0.8" opacity="0.7"/>`);
  out.push(`<circle cx="0" cy="${y(0)}" r="1.6" fill="#111827"/><text x="2.5" y="${r2(H + 5.5)}" font-size="4" fill="#111827">zero</text>`);
  out.push('</svg>');
  return out.join('');
}

// The sheet as it comes off the machine, from the toolpaths themselves: the
// stock (light), cut through wherever the bit went all the way down (dark: its
// path drawn as wide as the bit), the 0.5 mm tabs still holding the slugs and
// the parts (darker gray bars), and features left uncut (dashed red). Every
// copy is the same group, moved into place.
function cutPicture({ W, H, offsets, features, holes }) {
  const y = (v) => r1(H - v);
  const P = (p) => `${r1(p[0])} ${y(p[1])}`;
  // A stretch of a ring, from s0 to s1, as path data.
  const piece = (ring, s0, s1) => {
    if (ring.kind === 'circle') {
      const k = Math.ceil((s1 - s0) / ring.rho / Math.PI - 1e-9);
      let d = 'M' + P(pointAt(ring, s0));
      // (Y is flipped on screen, so a clockwise ring sweeps the positive way.)
      for (let i = 1; i <= k; i++) d += `A${r2(ring.rho)} ${r2(ring.rho)} 0 0 ${ring.cw ? 1 : 0} ${P(pointAt(ring, s0 + ((s1 - s0) * i) / k))}`;
      return d;
    }
    const pts = [pointAt(ring, s0)];
    for (let i = 1; i < ring.pts.length; i++) if (ring.cum[i] > s0 + 1e-9 && ring.cum[i] < s1 - 1e-9) pts.push(ring.pts[i]);
    pts.push(s1 >= ring.L - 1e-9 ? ring.pts[0] : pointAt(ring, s1));
    return 'M' + pts.map(P).join('L');
  };
  const cut = [], tabs = [], discs = [];
  for (const f of features) {
    if (f.kind === 'circle') { discs.push(`<circle cx="${r1(f.c[0])}" cy="${y(f.c[1])}" r="${r2(f.rings[f.rings.length - 1] + R)}"/>`); continue; }
    if (f.kind === 'poly') { for (const ring of f.levels.flat()) cut.push(piece(ring, 0, ring.L) + 'Z'); continue; }
    let s = 0;
    for (const [a, b] of [...f.tabs].sort((x, z) => x[0] - z[0])) {
      if (a > s) cut.push(piece(f.ring, s, a));
      tabs.push(piece(f.ring, a, b));
      s = b;
    }
    if (s < f.ring.L) cut.push(piece(f.ring, s, f.ring.L) + (s ? '' : 'Z'));
  }
  const round = ({ c, r }) => `M${r2(c[0] - r)} ${y(c[1])}a${r2(r)} ${r2(r)} 0 1 0 ${r2(2 * r)} 0a${r2(r)} ${r2(r)} 0 1 0 ${r2(-2 * r)} 0Z`;
  const skipped = holes.filter((h) => h.op === 'skip').map((h) => (h.circle ? round(h.circle) : 'M' + h.pts.map(P).join('L') + 'Z')).join('');
  const DARK = '#2b3038';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="-8 -8 ${r2(W + 16)} ${r2(H + 16)}">`,
    `<rect x="0" y="0" width="${r2(W)}" height="${r2(H)}" fill="#d3d7dd" stroke="#8b929c" stroke-width="0.4"/>`,
    '<defs><g id="cut">',
    tabs.length ? `<path d="${tabs.join('')}" fill="none" stroke="#8a919b" stroke-width="${CAM.tool}" stroke-linecap="butt" stroke-linejoin="round"/>` : '',
    cut.length ? `<path d="${cut.join('')}" fill="none" stroke="${DARK}" stroke-width="${CAM.tool}" stroke-linecap="round" stroke-linejoin="round"/>` : '',
    discs.length ? `<g fill="${DARK}">${discs.join('')}</g>` : '',
    skipped ? `<path d="${skipped}" fill="none" stroke="#dc2626" stroke-width="0.5" stroke-dasharray="1.2 0.8"/>` : '',
    '</g></defs>',
    ...offsets.map((off) => `<use href="#cut" xlink:href="#cut" transform="translate(${r1(off[0])} ${r1(-off[1])})"/>`),
    '</svg>'
  ].join('');
}

// One finished part: what's left once it's out of the sheet and the slugs are
// knocked out (inside corners rounded by the bit, tab stubs not shown), with
// the features that weren't cut marked (dashed red).
function partPicture({ kept, holes }) {
  if (!kept.length) return '';
  const b = bbox(kept), w = b[2] - b[0], h = b[3] - b[1], pad = Math.max(4, 0.03 * Math.max(w, h));
  const P = (p) => `${r1(p[0] - b[0])} ${r1(b[3] - p[1])}`;
  const shape = kept.map((l) => 'M' + simplify(l, 0.03).map(P).join('L') + 'Z').join('');
  const skipped = holes.filter((x) => x.op === 'skip').map((x) => 'M' + x.pts.map(P).join('L') + 'Z').join('');
  const label = `${r2(inch(w))} x ${r2(inch(h))} in. (${r1(w)} x ${r1(h)} mm)`;
  const fs = r1(Math.max(4, 0.035 * Math.max(w, h)));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r1(-pad)} ${r1(-pad)} ${r1(w + 2 * pad)} ${r1(h + 3 * pad + fs)}" font-family="sans-serif">`,
    `<path d="${shape}" fill="#cfd3d9" fill-rule="evenodd" stroke="#4b5563" stroke-width="${r2(Math.max(0.2, 0.0015 * Math.max(w, h)))}"/>`,
    skipped ? `<path d="${skipped}" fill="none" stroke="#dc2626" stroke-width="0.5" stroke-dasharray="1.2 0.8"/>` : '',
    `<text x="${r1(w / 2)}" y="${r1(h + 1.5 * pad + fs * 0.8)}" font-size="${fs}" text-anchor="middle" fill="#374151">${label}</text>`,
    '</svg>'
  ].join('');
}

// The report as plain text (the .c2d's notes, and the admin panel's copy button).
export function reportText(r, { version, file } = {}) {
  const lines = [
    `CrackBotics toolpath: ${r.part}${version ? ` V${version}` : ''}${file ? ` (${file})` : ''}`,
    `Stock: ${r.stock.w_in} x ${r.stock.h_in} x ${r.stock.t_in} in. (${r.stock.w_mm} x ${r.stock.h_mm} x ${r.stock.t_mm} mm)`,
    `Copies: ${r.copies}, ${r.layout.cols} x ${r.layout.rows}${r.layout.turned ? ', turned 90 degrees' : ''}. Zero: lower-left corner of the stock, top surface.`,
    `Tool: ${r.settings.tool}, ${r.settings.rpm} RPM, ${r.settings.feed_ipm} ipm cut, ${r.settings.plunge_ipm} ipm plunge.`,
    `Depth: ${r.depth_mm} mm through (stock + 0.254 mm), ${r.passes} passes of ${r.pass_mm} mm. Tabs 0.5 mm thick.`,
    `Run time (the .nc file): about ${r.run_minutes} min.`,
    `Operations: ${r.operations.pockets} holes cleared in rings, ${r.operations.inside_contours} openings cut inside (slug held by 3 tabs), ${r.operations.outside_contours} outside profiles last (${r.operations.tabs_per_outline.join(', ')} tabs each).`,
    `Area of one part: drawing ${r.area_mm2.drawing} mm2, as cut ${r.area_mm2.cut} mm2 (${r.area_mm2.left_on} mm2 left on: skipped features and inside corners).`
  ];
  if (r.skipped.length) lines.push('', 'Skipped (on each copy; positions on the first):', ...r.skipped.map((x) => `- ${x}`));
  if (r.warnings.length) lines.push('', 'Warnings:', ...r.warnings.map((x) => `- ${x}`));
  if (r.problems.length) lines.push('', 'PROBLEMS:', ...r.problems.map((x) => `- ${x}`));
  lines.push('', 'Assumptions:', ...r.assumptions.map((x) => `- ${x}`));
  return lines.join('\n') + '\n';
}
