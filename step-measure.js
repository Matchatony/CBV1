// Measures a STEP model as CNC plates. Shared by the quote page (index.html
// loads it when someone picks a STEP file, and prices each plate from it) and
// the Claude connector's analyze_part_file (api/_lib/step.js), so both get the
// same numbers. It works on what OpenCascade (occt-import-js) returns for the
// file, read with READ_OPTIONS: triangles grouped by the CAD model's faces.
// From those it measures each solid: thickness, plate size, the length of every
// contour the router follows, holes, pockets, and anything unusual (flags).

// How the file is read: millimeters, and a mesh fine enough that every hole
// keeps its round shape.
export const READ_OPTIONS = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.05, angularDeflection: 0.3 };
export const MM_PER_IN = 25.4;
export const STOCK_IN = [[0.125, '1/8 in.'], [0.1875, '3/16 in.'], [0.25, '1/4 in.'], [0.3125, '5/16 in.'], [0.375, '3/8 in.'], [0.5, '1/2 in.']];

// ---- Small vector helpers ----

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const r2 = (x) => Math.round(x * 100) / 100;

// ---- Mesh preparation ----

// Merges all meshes into one vertex list, welding vertices closer than 1 µm (the
// CAD faces are triangulated separately, so shared edges repeat their vertices).
function weld(meshes) {
  const EPS = 1e-3;
  const cells = new Map();
  const verts = [];
  const tris = []; // [a, b, c, face]
  let faceBase = 0;
  const find = (p) => {
    const cx = Math.floor(p[0] / EPS), cy = Math.floor(p[1] / EPS), cz = Math.floor(p[2] / EPS);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const ids = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (ids) for (const id of ids) if (Math.abs(verts[id][0] - p[0]) <= EPS && Math.abs(verts[id][1] - p[1]) <= EPS && Math.abs(verts[id][2] - p[2]) <= EPS) return id;
    }
    const id = verts.length;
    verts.push(p);
    const k = `${cx},${cy},${cz}`;
    (cells.get(k) || cells.set(k, []).get(k)).push(id);
    return id;
  };
  for (const mesh of meshes) {
    const pos = mesh.attributes.position.array, idx = mesh.index.array;
    const local = new Int32Array(pos.length / 3);
    for (let i = 0; i < local.length; i++) local[i] = find([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
    const faceOf = new Int32Array(idx.length / 3).fill(-1);
    (mesh.brep_faces || []).forEach((f, fi) => { for (let t = f.first; t <= f.last; t++) faceOf[t] = faceBase + fi; });
    let extra = (mesh.brep_faces || []).length;
    for (let t = 0; t < idx.length / 3; t++) {
      const a = local[idx[3 * t]], b = local[idx[3 * t + 1]], c = local[idx[3 * t + 2]];
      if (a === b || b === c || a === c) continue;
      tris.push([a, b, c, faceOf[t] >= 0 ? faceOf[t] : faceBase + extra++]);
    }
    faceBase += extra;
  }
  return { verts, tris };
}

// Splits triangles into connected solids (union-find over shared vertices).
function solids({ verts, tris }) {
  const parent = new Int32Array(verts.length).map((_, i) => i);
  const root = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (const [a, b, c] of tris) { parent[root(b)] = root(a); parent[root(c)] = root(a); }
  const groups = new Map();
  for (const t of tris) {
    const r = root(t[0]);
    (groups.get(r) || groups.set(r, []).get(r)).push(t);
  }
  return [...groups.values()];
}

// ---- 2D helpers ----

function signedArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]);
  return s / 2;
}

function insidePolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideTriangle(p, [a, b, c]) {
  const s1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const s2 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]);
  const s3 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

// Least-squares circle through a loop's points; a loop counts as a round hole when
// every point is within 2% of the radius (or 0.05 mm) of that circle.
function fitCircle(pts) {
  if (pts.length < 8) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  const n = pts.length;
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] [D E F] = -[sxz syz sz]
  const m = [[sxx, sxy, sx, -sxz], [sxy, syy, sy, -syz], [sx, sy, n, -sz]];
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    if (Math.abs(m[c][c]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]; }
  }
  const D = m[0][3] / m[0][0], E = m[1][3] / m[1][1], F = m[2][3] / m[2][2];
  const cx = -D / 2, cy = -E / 2, r = Math.sqrt(cx * cx + cy * cy - F);
  if (!(r > 0)) return null;
  const worst = pts.reduce((w, [x, y]) => Math.max(w, Math.abs(Math.hypot(x - cx, y - cy) - r)), 0);
  return worst <= Math.max(0.02 * r, 0.05) ? { center: [cx, cy], r } : null;
}

// A point just inside a closed loop (in the opening it encloses).
function pointInside(pts, circle) {
  if (circle) return circle.center;
  const step = 0.05;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    if (l < 1e-6) continue;
    for (const s of [1, -1]) {
      const p = [(a[0] + b[0]) / 2 - (s * dy / l) * step, (a[1] + b[1]) / 2 + (s * dx / l) * step];
      if (insidePolygon(p, pts)) return p;
    }
  }
  return pts[0];
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.reverse()) { while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Smallest rectangle around the points (it lines up with one hull edge):
// { length, width, angle } with length >= width, angle turning the length onto x.
export function minRect(points) {
  const hull = convexHull(points);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of hull) {
      const rx = x * c - y * s, ry = x * s + y * c;
      x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, ry); y1 = Math.max(y1, ry);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area < best.area - 1e-9) best = { area, w: x1 - x0, h: y1 - y0, ang };
  }
  if (!best) return { length: 0, width: 0, angle: 0 };
  let angle = best.w >= best.h ? best.ang : best.ang + Math.PI / 2;
  // The smallest turn that lines the length up with x (never more than 90°).
  angle = ((angle % Math.PI) + Math.PI) % Math.PI;
  if (angle > Math.PI / 2) angle -= Math.PI;
  return { length: Math.max(best.w, best.h), width: Math.min(best.w, best.h), angle };
}

// ---- One solid ----

// rate.minToolDiaIn: the smallest end mill, for the small-holes flag.
function measureSolid(tris, verts, rate) {
  // Per CAD face: its triangles, area, and average normal.
  const faces = new Map();
  let area = 0, volume = 0;
  for (const t of tris) {
    const [a, b, c] = [verts[t[0]], verts[t[1]], verts[t[2]]];
    const n = cross(sub(b, a), sub(c, a));
    const A = len(n) / 2;
    area += A;
    volume += dot(a, cross(b, c)) / 6;
    if (A < 1e-12) continue;
    const f = faces.get(t[3]) || faces.set(t[3], { tris: [], area: 0, sum: [0, 0, 0], tri: [] }).get(t[3]);
    f.tris.push(t); f.area += A;
    f.sum = [f.sum[0] + n[0] / 2, f.sum[1] + n[1] / 2, f.sum[2] + n[2] / 2];
    f.tri.push({ m: unit(n), A });
  }
  // A face is flat when all its corners lie on one plane. (Corners, not triangle
  // normals: the long thin triangles on a big face with many holes get noisy normals.)
  const PLANE_TOL = 0.002;
  for (const f of faces.values()) {
    f.n = unit(f.sum);
    const ids = new Set(f.tris.flatMap((t) => t.slice(0, 3)));
    let lo = Infinity, hi = -Infinity;
    for (const i of ids) { const h = dot(f.n, verts[i]); if (h < lo) lo = h; if (h > hi) hi = h; }
    f.flat = hi - lo <= PLANE_TOL;
  }
  const FLAT = 1 - 1e-6;

  // The plate's normal: the direction with the most flat-face area.
  const dirs = [];
  for (const f of faces.values()) {
    if (!f.flat) continue;
    const d = dirs.find((x) => Math.abs(dot(x.n, f.n)) > FLAT);
    if (d) d.area += f.area; else dirs.push({ n: f.n, area: f.area });
  }
  if (!dirs.length) return { flat_plate: false, area, volume: Math.abs(volume) };
  let n = dirs.reduce((x, y) => (y.area > x.area ? y : x)).n;

  const ids = [...new Set(tris.flatMap((t) => t.slice(0, 3)))];
  const classify = (n) => {
    let lo = Infinity, hi = -Infinity;
    for (const i of ids) { const h = dot(n, verts[i]); if (h < lo) lo = h; if (h > hi) hi = h; }
    const tol = Math.max(0.005, 1e-5 * (hi - lo));
    const out = { lo, hi, tol, top: [], bottom: [], floors: [], under: [], sloped: 0 };
    for (const f of faces.values()) {
      const along = dot(f.n, n);
      if (f.flat && Math.abs(along) > FLAT) {
        const h = dot(n, verts[f.tris[0][0]]);
        if (along > 0 && Math.abs(h - hi) < tol) out.top.push(f);
        else if (along < 0 && Math.abs(h - lo) < tol) out.bottom.push(f);
        else if (along > 0) out.floors.push({ f, h });
        else out.under.push({ f, h });
      } else {
        // Side walls (flat or round) face sideways. Area facing up or down at an
        // angle (chamfers, fillets, 3D shapes) means it isn't a plain 2D plate.
        for (const { m, A } of f.tri) if (Math.abs(dot(m, n)) > 0.01) out.sloped += A;
      }
    }
    return out;
  };
  let c = classify(n);
  // Cut from the side that has the pockets: flip if more of them face down.
  const sum = (list) => list.reduce((s, x) => s + x.f.area, 0);
  if (sum(c.under) > sum(c.floors)) { n = n.map((x) => -x); c = classify(n); }

  // 2D coordinates in the plate's plane, lined up with the file's own X (and Y)
  // where possible so the picture matches the CAD top view. (u, v, n) is
  // right-handed, so this is the view from above, not a mirror image.
  const axis = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(sub(axis, n.map((x) => x * dot(axis, n)))), v = cross(n, u);
  const to2d = (p) => [dot(p, u), dot(p, v)];
  const thickness = c.hi - c.lo;

  // Up-facing flat faces below a height, projected, for "what's under this point".
  const levels = [...c.floors.map(({ f, h }) => ({ f, h })), ...c.top.map((f) => ({ f, h: c.hi }))]
    .map(({ f, h }) => ({ h, tris: f.tris.map((t) => [to2d(verts[t[0]]), to2d(verts[t[1]]), to2d(verts[t[2]])]) }));
  const floorUnder = (p, below) => {
    let best = null;
    for (const L of levels) {
      if (L.h >= below - c.tol || (best !== null && L.h <= best)) continue;
      if (L.tris.some((tri) => insideTriangle(p, tri))) best = L.h;
    }
    return best;
  };

  // Closed boundary loops of a set of faces. A directed edge a→b is on the
  // boundary when no triangle has b→a; the faces' triangles run counterclockwise
  // seen from above, so the material is on the left of it and the opening on the
  // right. Where two openings touch at one corner, more than one boundary edge
  // leaves that vertex: the walk takes the one that keeps hugging the same opening
  // (the first one counterclockwise from the way it came in), so each opening
  // comes out as its own loop.
  const loopsOf = (faceList) => {
    const edges = new Set();
    for (const f of faceList) for (const [a, b, cc] of f.tris) edges.add(`${a}>${b}`).add(`${b}>${cc}`).add(`${cc}>${a}`);
    const outs = new Map();
    for (const key of edges) {
      const [a, b] = key.split('>').map(Number);
      if (!edges.has(`${b}>${a}`)) (outs.get(a) || outs.set(a, []).get(a)).push(b);
    }
    const used = new Set(), loops = [];
    const after = (a, b) => {
      const options = (outs.get(b) || []).filter((x) => !used.has(`${b}>${x}`));
      if (options.length < 2) return options[0];
      const [bx, by] = to2d(verts[b]), [ax, ay] = to2d(verts[a]);
      const back = Math.atan2(ay - by, ax - bx);
      const turn = (x) => { const [xx, xy] = to2d(verts[x]); const d = Math.atan2(xy - by, xx - bx) - back; return ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI; };
      return options.reduce((x, y) => (turn(y) < turn(x) ? y : x));
    };
    for (const [p, targets] of outs) for (const q of targets) {
      if (used.has(`${p}>${q}`)) continue;
      const ring = [];
      let a = p, b = q, length = 0, closed = false;
      while (b !== undefined && !used.has(`${a}>${b}`)) {
        used.add(`${a}>${b}`);
        ring.push(a);
        length += len(sub(verts[b], verts[a]));
        if (b === p) { closed = true; break; }
        [a, b] = [b, after(a, b)];
      }
      if (!closed || ring.length < 3) continue;
      const pts = ring.map((i) => to2d(verts[i]));
      loops.push({ pts, length, area: signedArea(pts) });
    }
    return loops;
  };

  const floorHeights = [...new Set(c.floors.map((x) => Math.round(x.h / c.tol)))].map((k) => c.floors.find((x) => Math.round(x.h / c.tol) === k).h);
  return finishPlate({
    topLoops: loopsOf(c.top),
    floorLevels: floorHeights.map((h) => ({ h, loops: loopsOf(c.floors.filter((x) => Math.abs(x.h - h) < c.tol).map((x) => x.f)) })),
    floorUnder, thickness, hi: c.hi, lo: c.lo, flat: c.sloped <= 1e-4 * area + 0.5, bottom: c.under.length > 0, area, volume: Math.abs(volume)
  }, rate);
}

// The plate, from the loops (2D, seen from above) of its top face and of each
// pocket floor level: { pts, length, area, circle? }, where a face's own outer
// edge runs counterclockwise (positive area) and the openings in it clockwise,
// so several pocket floors at one depth each keep their own outline.
// floorUnder(p, h): the height of the highest floor or top under point p below
// height h, or null when it's open all the way through.
function finishPlate({ topLoops, floorLevels, floorUnder, thickness, hi, lo, flat, bottom, area, volume }, rate) {
  // Contours: the outline, then every opening in the top face or a pocket floor,
  // sorted into through holes, through cutouts and blind pockets by what lies under it.
  const contours = [];
  const outer = topLoops.filter((l) => l.area > 0).reduce((x, y) => (!x || y.area > x.area ? y : x), null);
  if (outer) contours.push({ type: 'outline', length: outer.length, depth: thickness, pts: outer.pts });
  const levelLoops = [{ h: hi, loops: topLoops.filter((l) => l.area < 0), outlines: [] }]
    .concat(floorLevels.map(({ h, loops }) => ({ h, loops: loops.filter((l) => l.area < 0), outlines: loops.filter((l) => l.area > 0) })));
  for (const { h, loops } of levelLoops) for (const l of loops) {
    const circle = l.circle || fitCircle(l.pts);
    const floor = floorUnder(pointInside(l.pts, circle), h);
    const through = floor === null;
    contours.push({
      type: through ? (circle ? 'hole' : 'cutout') : 'pocket',
      // A round opening's length is its true circumference, not the mesh's polygon.
      length: circle ? 2 * Math.PI * circle.r : l.length, depth: through ? h - lo : h - floor,
      diameter: circle ? 2 * circle.r : null, center: circle ? circle.center : null, area: Math.abs(l.area), pts: l.pts, from: hi - h
    });
  }

  // Anything a plain flat plate wouldn't have, as { id, text }.
  const flags = [];
  if (!flat) flags.push({ id: 'sloped', text: 'Has sloped or curved faces (e.g. chamfers, fillets on top edges, or a 3D shape), so it isn\'t a plain 2D plate.' });
  if (bottom) flags.push({ id: 'both_sides', text: 'Has features cut into the bottom face: needs flipping and a second setup.' });
  if (!outer) flags.push({ id: 'no_outline', text: 'Couldn\'t find the top face\'s outline.' });
  // A pocket floor reaching past the top outline is a step around the outside
  // edge (a rabbet), which the cut length above doesn't include.
  const box = (pts) => pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  if (outer && levelLoops.slice(1).some(({ outlines }) => outlines.some((outline) => {
    const [a0, a1, a2, a3] = box(outer.pts), [b0, b1, b2, b3] = box(outline.pts);
    return b0 < a0 - 0.01 || b1 < a1 - 0.01 || b2 > a2 + 0.01 || b3 > a3 + 0.01;
  }))) flags.push({ id: 'edge_step', text: 'Has a step cut around the outside edge: the cut length counts only the top outline, so check that step by hand.' });
  const minTool = rate.minToolDiaIn * MM_PER_IN;
  const tiny = contours.filter((x) => x.diameter !== null && x.diameter < minTool - 1e-3);
  if (tiny.length) {
    const smallest = r2(tiny.reduce((d, x) => Math.min(d, x.diameter), Infinity));
    flags.push({ id: 'small_holes', count: tiny.length, smallest_mm: smallest,
      text: `${tiny.length} round feature(s) smaller than the ${rate.minToolDiaIn} in. minimum tool (smallest Ø${smallest} mm): drill them or confirm with the customer.` });
  }
  const stock = STOCK_IN.find(([t]) => Math.abs(t * MM_PER_IN - thickness) <= 0.1);

  const rect = outer ? minRect(outer.pts) : { length: 0, width: 0, angle: 0 };
  return {
    flat_plate: flat && !!outer, flags, contours, rect, area, volume, thickness,
    stock: stock ? stock[1] : 'nonstandard',
    floors: levelLoops.slice(1).map(({ h, loops, outlines }) => ({ depth: hi - h, loops: [...outlines, ...loops].map((l) => l.pts) })),
    topLoops: topLoops.map((l) => l.pts)
  };
}

// ---- Reading a plate straight from the STEP file ----
//
// OpenCascade meshes the whole model first, and for a plate with hundreds of
// holes (a typical FTC grid plate) that takes a minute or more. The file itself
// already holds what a plate's price needs: its flat faces, and the lines,
// circles and curves around them. measureStepText reads those directly, in well
// under a second, into the same measurements as measureModel. Anything it
// doesn't handle (instanced geometry, a split top face, unusual entities) makes
// it return null, and the caller measures the mesh instead.

class Unsupported extends Error {}

// The DATA section's records by id, still unparsed, and their ids by type.
function stepRecords(text) {
  const start = text.indexOf('DATA;');
  if (start < 0) return null;
  const recs = new Map(), byType = new Map(), n = text.length;
  let i = start + 5;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 35) { // '#'
      let j = i + 1;
      while (j < n && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++;
      const eq = text.indexOf('=', j);
      if (eq < 0) break;
      let k = eq + 1, inString = false;
      for (; k < n; k++) {
        const d = text.charCodeAt(k);
        if (d === 39) inString = !inString; // '
        else if (d === 59 && !inString) break; // ;
      }
      const body = text.slice(eq + 1, k).trim();
      const m = /^([A-Z0-9_]+)\s*\(/.exec(body);
      const type = m ? m[1] : 'COMPLEX';
      const id = Number(text.slice(i + 1, j));
      recs.set(id, body);
      (byType.get(type) || byType.set(type, []).get(type)).push(id);
      i = k + 1;
    } else if (c === 47 && text.charCodeAt(i + 1) === 42) { // a /* comment */
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === 69 && text.startsWith('ENDSEC', i)) {
      break;
    } else {
      i++;
    }
  }
  return { recs, byType };
}

// One record: { type, args } or, for a complex entity, { type: 'COMPLEX', parts }.
// Values: numbers, strings, lists, { ref }, { enum }, { type, args } (typed), null.
function parseRecord(s) {
  let i = 0;
  const skip = () => { while (i < s.length && s.charCodeAt(i) <= 32) i++; };
  const word = () => {
    const re = /[A-Z0-9_]+/y; re.lastIndex = i;
    const m = re.exec(s);
    if (!m) throw new Unsupported('unreadable record');
    i += m[0].length;
    return m[0];
  };
  const value = () => {
    skip();
    const c = s[i];
    if (c === '(') {
      i++;
      const list = [];
      skip();
      if (s[i] === ')') { i++; return list; }
      for (;;) {
        list.push(value());
        skip();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ')') { i++; return list; }
        throw new Unsupported('unreadable record');
      }
    }
    if (c === "'") {
      let out = '';
      i++;
      for (;;) {
        const q = s.indexOf("'", i);
        if (q < 0) throw new Unsupported('unreadable record');
        out += s.slice(i, q);
        if (s[q + 1] === "'") { out += "'"; i = q + 2; } else { i = q + 1; return out; }
      }
    }
    if (c === '#') {
      const re = /#(\d+)/y; re.lastIndex = i;
      const m = re.exec(s);
      i += m[0].length;
      return { ref: Number(m[1]) };
    }
    if (c === '$' || c === '*') { i++; return null; }
    if (c === '.' && /[A-Z_]/.test(s[i + 1] || '')) {
      const e = s.indexOf('.', i + 1);
      const v = s.slice(i + 1, e);
      i = e + 1;
      return { enum: v };
    }
    if (c === '"') { const e = s.indexOf('"', i + 1); i = e + 1; return null; } // binary: never needed here
    const re = /[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/y; re.lastIndex = i;
    const m = re.exec(s);
    if (m && m[0]) { i += m[0].length; return Number(m[0]); }
    const type = word(); // a typed value, e.g. LENGTH_MEASURE(25.4)
    return { type, args: value() };
  };
  skip();
  if (s[i] === '(') {
    i++;
    const parts = {};
    for (;;) {
      skip();
      if (s[i] === ')' || i >= s.length) break;
      const name = word();
      parts[name] = value();
    }
    return { type: 'COMPLEX', parts };
  }
  const type = word();
  return { type, args: value() };
}

function stepFile(text) {
  const data = stepRecords(text);
  if (!data) return null;
  const cache = new Map();
  const get = (ref) => {
    const id = typeof ref === 'number' ? ref : ref && ref.ref;
    let e = cache.get(id);
    if (!e) {
      const body = data.recs.get(id);
      if (body === undefined) throw new Unsupported(`missing #${id}`);
      e = parseRecord(body);
      cache.set(id, e);
    }
    return e;
  };
  return { get, ids: (type) => data.byType.get(type) || [], has: (type) => data.byType.has(type) };
}

// Millimeters per unit of the length unit an entity names.
const SI_PREFIX = { KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9 };
function unitMm(file, e) {
  const p = e.type === 'COMPLEX' ? e.parts : { [e.type]: e.args };
  if (p.SI_UNIT) {
    const [prefix, name] = p.SI_UNIT.length > 2 ? p.SI_UNIT.slice(1) : p.SI_UNIT;
    if (!name || name.enum !== 'METRE') throw new Unsupported('length unit');
    if (prefix && !(prefix.enum in SI_PREFIX)) throw new Unsupported('length unit');
    return 1000 * (prefix ? SI_PREFIX[prefix.enum] : 1);
  }
  if (p.CONVERSION_BASED_UNIT) {
    const m = file.get(p.CONVERSION_BASED_UNIT[1]);
    let v = m.args[0];
    if (v && typeof v === 'object') v = v.args[0];
    if (!(v > 0)) throw new Unsupported('length unit');
    return v * unitMm(file, file.get(m.args[1]));
  }
  throw new Unsupported('length unit');
}
function lengthUnit(file, contextRef) {
  const ctx = file.get(contextRef);
  const units = ctx.type === 'COMPLEX' && ctx.parts.GLOBAL_UNIT_ASSIGNED_CONTEXT && ctx.parts.GLOBAL_UNIT_ASSIGNED_CONTEXT[0];
  for (const u of units || []) {
    const e = file.get(u);
    if ((e.type === 'COMPLEX' && e.parts.LENGTH_UNIT) || e.type === 'LENGTH_UNIT') return unitMm(file, e);
  }
  throw new Unsupported('no length unit');
}

// A B-spline curve's point at parameter t (de Boor), rational or not.
function splinePoint({ p, P, U, W }, t) {
  const n = P.length - 1;
  let span = n;
  for (let j = p; j <= n; j++) if (t < U[j + 1]) { span = j; break; }
  const d = [];
  for (let j = 0; j <= p; j++) {
    const i = span - p + j, w = W ? W[i] : 1;
    d.push([P[i][0] * w, P[i][1] * w, P[i][2] * w, w]);
  }
  for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
    const i = span - p + j, den = U[i + p - r + 1] - U[i], a = den ? (t - U[i]) / den : 0;
    for (let c = 0; c < 4; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
  }
  const q = d[p];
  return [q[0] / q[3], q[1] / q[3], q[2] / q[3]];
}

const dist = (a, b) => len(sub(a, b));
const polyLength = (pts) => pts.reduce((s, q, i) => (i ? s + dist(pts[i - 1], q) : 0), 0);

// The faces of the file's solids, read with lengths in millimeters (k per unit):
// face(ref) gives { plane: { n, o } (n pointing out of the solid) or null,
// loops: [{ pts, length, circle }] }, each loop a 3D polygon in order. Arcs are
// split every 0.1 rad, or finer where that would stray more than tol mm from
// the true curve (toolpaths need 0.005 mm; measuring doesn't).
function brepReader(file, k, tol) {
  const point = (ref) => {
    const e = file.get(ref);
    if (e.type !== 'CARTESIAN_POINT') throw new Unsupported('point');
    const c = e.args[1];
    return [c[0] * k, c[1] * k, (c[2] || 0) * k];
  };
  const direction = (ref) => {
    if (!ref) return null;
    const e = file.get(ref);
    if (e.type !== 'DIRECTION') throw new Unsupported('direction');
    const c = e.args[1];
    return unit([c[0], c[1], c[2] || 0]);
  };
  const place = (ref) => {
    const e = file.get(ref);
    if (e.type !== 'AXIS2_PLACEMENT_3D') throw new Unsupported('placement');
    const o = point(e.args[1]), z = direction(e.args[2]) || [0, 0, 1];
    let x = direction(e.args[3]) || (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    x = unit(sub(x, z.map((v) => v * dot(x, z))));
    return { o, z, x, y: cross(z, x) };
  };
  const vertex = (ref) => {
    const e = file.get(ref);
    if (e.type !== 'VERTEX_POINT') throw new Unsupported('vertex');
    return point(e.args[1]);
  };
  const spline = (p, cps, mults, knots, weights) => {
    const U = [];
    knots.forEach((u, i) => { for (let m = 0; m < mults[i]; m++) U.push(u); });
    const P = cps.map(point);
    if (U.length !== P.length + p + 1) throw new Unsupported('spline');
    return { kind: 'spline', p, P, U, W: weights };
  };
  const curve = (ref) => {
    const e = file.get(ref);
    const a = e.args;
    switch (e.type) {
      case 'LINE': return { kind: 'line' };
      case 'CIRCLE': return { kind: 'conic', ax: place(a[1]), a: a[2] * k, b: a[2] * k, circle: true };
      case 'ELLIPSE': return { kind: 'conic', ax: place(a[1]), a: a[2] * k, b: a[3] * k };
      case 'SURFACE_CURVE': case 'SEAM_CURVE': case 'BOUNDED_SURFACE_CURVE': case 'TRIMMED_CURVE': return curve(a[1]);
      case 'POLYLINE': return { kind: 'polyline', pts: a[1].map(point) };
      case 'B_SPLINE_CURVE_WITH_KNOTS': return spline(a[1], a[2], a[6], a[7], null);
      case 'COMPLEX': {
        const q = e.parts;
        if (q.B_SPLINE_CURVE && q.B_SPLINE_CURVE_WITH_KNOTS) {
          return spline(q.B_SPLINE_CURVE[0], q.B_SPLINE_CURVE[1], q.B_SPLINE_CURVE_WITH_KNOTS[0], q.B_SPLINE_CURVE_WITH_KNOTS[1],
            q.RATIONAL_B_SPLINE_CURVE ? q.RATIONAL_B_SPLINE_CURVE[0] : null);
        }
      }
    }
    throw new Unsupported(`curve ${e.type}`);
  };

  // An edge as points from its start vertex to its end vertex, its length, and
  // its circle when it's an arc of one.
  const edges = new Map();
  const edge = (ref) => {
    if (edges.has(ref.ref)) return edges.get(ref.ref);
    const e = file.get(ref);
    if (e.type !== 'EDGE_CURVE') throw new Unsupported(`edge ${e.type}`);
    const A = vertex(e.args[1]), B = vertex(e.args[2]), cv = curve(e.args[3]), forward = !e.args[4] || e.args[4].enum !== 'F';
    const closed = dist(A, B) < 1e-6;
    let out;
    if (cv.kind === 'line') {
      out = { pts: [A, B], length: dist(A, B) };
    } else if (cv.kind === 'conic') {
      // Counterclockwise about the axis is the curve's own direction.
      const { ax } = cv, T = 2 * Math.PI;
      const angle = (q) => { const d = sub(q, ax.o); return Math.atan2(dot(d, ax.y) / cv.b, dot(d, ax.x) / cv.a); };
      const turn = (x) => { const m = ((x % T) + T) % T; return m < 1e-9 ? T : m; };
      const t0 = angle(A), sweep = closed ? (forward ? T : -T) : forward ? turn(angle(B) - t0) : -turn(t0 - angle(B));
      const at = (t) => ax.o.map((o, i) => o + ax.x[i] * cv.a * Math.cos(t) + ax.y[i] * cv.b * Math.sin(t));
      const step = tol ? Math.min(0.1, 2 * Math.acos(Math.max(0, 1 - tol / Math.max(cv.a, cv.b)))) : 0.1;
      const steps = Math.max(2, Math.ceil(Math.abs(sweep) / step));
      const pts = [];
      for (let s = 0; s <= steps; s++) pts.push(at(t0 + (sweep * s) / steps));
      pts[0] = A; pts[steps] = B;
      let length = Math.abs(sweep) * cv.a;
      if (!cv.circle) {
        const fine = [];
        const n = Math.max(8, Math.ceil(Math.abs(sweep) / 0.01));
        for (let s = 0; s <= n; s++) fine.push(at(t0 + (sweep * s) / n));
        length = polyLength(fine);
      }
      out = { pts, length, circle: cv.circle ? { c: ax.o, r: cv.a, z: ax.z } : null };
    } else {
      // A spline or polyline: sample it, then keep the stretch between the vertices.
      let samples;
      if (cv.kind === 'spline') {
        const t0 = cv.U[cv.p], t1 = cv.U[cv.P.length], n = Math.max(32, 8 * (cv.P.length - cv.p));
        samples = [];
        for (let s = 0; s <= n; s++) samples.push(splinePoint(cv, t0 + ((t1 - t0) * s) / n));
      } else {
        samples = cv.pts;
      }
      const nearest = (q) => samples.reduce((best, x, i) => (dist(x, q) < dist(samples[best], q) ? i : best), 0);
      let ia = nearest(A), ib = nearest(B);
      if (!forward) { samples = samples.slice().reverse(); ia = samples.length - 1 - ia; ib = samples.length - 1 - ib; }
      let pts;
      if (closed) pts = samples.slice(ia).concat(samples.slice(1, ia + 1));
      else if (ia <= ib) pts = samples.slice(ia, ib + 1);
      else pts = samples.slice(ia).concat(samples.slice(1, ib + 1)); // a periodic curve, across its seam
      pts = [A, ...pts.slice(1, -1), B];
      out = { pts, length: polyLength(pts) };
    }
    edges.set(ref.ref, out);
    return out;
  };

  // A face bound's loop, in order, with the circle all its edges lie on (a
  // round hole), if they do.
  const loop = (ref) => {
    const e = file.get(ref);
    if (e.type === 'VERTEX_LOOP') return null;
    if (e.type === 'POLY_LOOP') {
      const pts = e.args[1].map(point);
      return { pts, length: polyLength(pts.concat([pts[0]])), circle: null };
    }
    if (e.type !== 'EDGE_LOOP') throw new Unsupported(`loop ${e.type}`);
    const pts = [], circles = [];
    let length = 0;
    for (const r of e.args[1]) {
      const oe = file.get(r);
      if (oe.type !== 'ORIENTED_EDGE') throw new Unsupported('oriented edge');
      const ed = edge(oe.args[3]);
      const seq = oe.args[4] && oe.args[4].enum === 'F' ? ed.pts.slice().reverse() : ed.pts;
      for (let i = pts.length ? 1 : 0; i < seq.length; i++) pts.push(seq[i]);
      length += ed.length;
      circles.push(ed.circle);
    }
    if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
    const c0 = circles[0];
    const round = c0 && circles.every((c) => c && dist(c.c, c0.c) < 1e-3 && Math.abs(c.r - c0.r) < 1e-3);
    return { pts, length, circle: round ? c0 : null };
  };

  const face = (ref) => {
    const e = file.get(ref);
    if (e.type !== 'ADVANCED_FACE' && e.type !== 'FACE_SURFACE') throw new Unsupported(`face ${e.type}`);
    const surface = file.get(e.args[2]), same = !e.args[3] || e.args[3].enum !== 'F';
    let plane = null;
    if (surface.type === 'PLANE') {
      const ax = place(surface.args[1]);
      plane = { n: same ? ax.z : ax.z.map((v) => -v), o: ax.o };
    }
    const loops = [];
    for (const b of e.args[1]) {
      const fb = file.get(b);
      if (fb.type !== 'FACE_BOUND' && fb.type !== 'FACE_OUTER_BOUND') throw new Unsupported('face bound');
      const l = loop(fb.args[1]);
      if (!l) continue;
      if (fb.args[2] && fb.args[2].enum === 'F') l.pts = l.pts.slice().reverse();
      loops.push(l);
    }
    return { plane, loops };
  };
  return { face };
}

// Area vector of a closed 3D polygon (Newell's method).
function areaVector(pts) {
  let x = 0, y = 0, z = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay, az] = pts[j], [bx, by, bz] = pts[i];
    x += (ay - by) * (az + bz); y += (az - bz) * (ax + bx); z += (ax - bx) * (ay + by);
  }
  return [x / 2, y / 2, z / 2];
}

// One solid's faces (brepReader) measured as a plate, like measureSolid. With
// profile set, the result also keeps the 2D loops of the top and bottom faces
// (m.profile), which toolpaths are cut from.
function measureFaces(faces, rate, profile) {
  for (const f of faces) for (const l of f.loops) l.vec = areaVector(l.pts);
  // A flat face's area: its outer loop's, less its openings'.
  for (const f of faces) {
    if (!f.plane) continue;
    const a = f.loops.map((l) => Math.abs(dot(l.vec, f.plane.n)));
    const big = Math.max(0, ...a);
    f.area = 2 * big - a.reduce((x, y) => x + y, 0);
  }
  const FLAT = 1 - 1e-6;
  const dirs = [];
  for (const f of faces) {
    if (!f.plane) continue;
    const d = dirs.find((x) => Math.abs(dot(x.n, f.plane.n)) > FLAT);
    if (d) d.area += f.area; else dirs.push({ n: f.plane.n, area: f.area });
  }
  const flatArea = faces.reduce((s, f) => s + (f.area || 0), 0);
  if (!dirs.length) return { flat_plate: false, area: flatArea, volume: 0 };
  let n = dirs.reduce((x, y) => (y.area > x.area ? y : x)).n;

  const corners = faces.flatMap((f) => f.loops.flatMap((l) => l.pts));
  const classify = (n) => {
    let lo = Infinity, hi = -Infinity;
    for (const q of corners) { const h = dot(n, q); if (h < lo) lo = h; if (h > hi) hi = h; }
    const tol = Math.max(0.005, 1e-5 * (hi - lo));
    const out = { lo, hi, tol, top: [], bottom: [], floors: [], under: [], sloped: 0 };
    for (const f of faces) {
      const along = f.plane ? dot(f.plane.n, n) : 0;
      if (f.plane && Math.abs(along) > FLAT) {
        const h = dot(n, f.plane.o);
        if (along > 0 && Math.abs(h - hi) < tol) out.top.push(f);
        else if (along < 0 && Math.abs(h - lo) < tol) out.bottom.push(f);
        else if (along > 0) out.floors.push({ f, h });
        else out.under.push({ f, h });
      } else {
        // A side wall (flat or round) seen from above covers no area. Anything
        // that does (chamfers, fillets, 3D shapes) isn't a plain 2D plate.
        out.sloped += Math.abs(f.loops.reduce((s, l) => s + dot(l.vec, n), 0));
      }
    }
    return out;
  };
  let c = classify(n);
  // Cut from the side that has the pockets: flip if more of them face down.
  const sum = (list) => list.reduce((s, x) => s + x.f.area, 0);
  if (sum(c.under) > sum(c.floors)) { n = n.map((x) => -x); c = classify(n); }
  if (c.top.length > 1) throw new Unsupported('top face in pieces');

  // The same 2D view from above as measureSolid.
  const axis = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(sub(axis, n.map((x) => x * dot(axis, n)))), v = cross(n, u);
  const to2d = (q) => [dot(q, u), dot(q, v)];
  const thickness = c.hi - c.lo;
  // A face's loops in 2D: its outer edge with positive area, openings negative.
  const flatLoops = (f) => {
    if (f.loops2d) return f.loops2d;
    const ls = f.loops.map((l) => ({ pts: l.pts.map(to2d), length: l.length, circle: l.circle && Math.abs(dot(l.circle.z, n)) > FLAT ? { center: to2d(l.circle.c), r: l.circle.r } : null }));
    for (const l of ls) l.area = Math.abs(signedArea(l.pts));
    const outer = ls.reduce((x, y) => (y.area > x.area ? y : x), ls[0]);
    for (const l of ls) if (l !== outer) l.area = -l.area;
    for (const l of ls) if (l.area > 0 && signedArea(l.pts) < 0) l.pts.reverse();
    return (f.loops2d = ls);
  };
  const regions = [...c.floors, ...c.top.map((f) => ({ f, h: c.hi }))].map(({ f, h }) => {
    const ls = flatLoops(f);
    return { h, outer: ls.find((l) => l.area > 0), holes: ls.filter((l) => l.area < 0) };
  });
  const floorUnder = (p, below) => {
    let best = null;
    for (const r of regions) {
      if (r.h >= below - c.tol || (best !== null && r.h <= best) || !r.outer) continue;
      if (insidePolygon(p, r.outer.pts) && !r.holes.some((hl) => insidePolygon(p, hl.pts))) best = r.h;
    }
    return best;
  };
  const floorHeights = [...new Set(c.floors.map((x) => Math.round(x.h / c.tol)))].map((key) => c.floors.find((x) => Math.round(x.h / c.tol) === key).h);
  // Volume from the flat faces: each up-facing one stands on its height above
  // the bottom, each down-facing one takes its height away.
  const volume = [...c.top.map((f) => ({ f, h: c.hi })), ...c.floors].reduce((s, { f, h }) => s + f.area * (h - c.lo), 0) -
    c.under.reduce((s, { f, h }) => s + f.area * (h - c.lo), 0);
  const m = finishPlate({
    topLoops: c.top.length ? flatLoops(c.top[0]) : [],
    floorLevels: floorHeights.map((h) => ({ h, loops: c.floors.filter((x) => Math.abs(x.h - h) < c.tol).flatMap((x) => flatLoops(x.f)) })),
    floorUnder, thickness, hi: c.hi, lo: c.lo, flat: c.sloped <= 1e-4 * flatArea + 0.5, bottom: c.under.length > 0,
    area: 0, volume
  }, rate);
  // Surface area: the flat faces plus the walls around every contour.
  m.area = [...c.top, ...c.bottom].reduce((s, f) => s + f.area, 0) + [...c.floors, ...c.under].reduce((s, x) => s + x.f.area, 0) +
    m.contours.reduce((s, x) => s + x.length * x.depth, 0);
  if (profile) m.profile = { top: c.top.length ? flatLoops(c.top[0]) : [], bottom: c.bottom.length === 1 ? flatLoops(c.bottom[0]) : null };
  return m;
}

// How many times each product is used: once on its own, or as often as the
// assemblies above it use it.
function instanceCounter(file) {
  const pdsOfRep = new Map(), linked = new Map(), usedBy = new Map(), memo = new Map();
  for (const id of file.ids('SHAPE_DEFINITION_REPRESENTATION')) {
    const a = file.get(id).args;
    if (a[0] && a[1]) pdsOfRep.set(a[1].ref, a[0].ref);
  }
  for (const id of file.ids('SHAPE_REPRESENTATION_RELATIONSHIP')) {
    const a = file.get(id).args;
    if (!a[2] || !a[3]) continue;
    (linked.get(a[2].ref) || linked.set(a[2].ref, []).get(a[2].ref)).push(a[3].ref);
    (linked.get(a[3].ref) || linked.set(a[3].ref, []).get(a[3].ref)).push(a[2].ref);
  }
  for (const id of file.ids('NEXT_ASSEMBLY_USAGE_OCCURRENCE')) {
    const a = file.get(id).args;
    if (a[3] && a[4]) (usedBy.get(a[4].ref) || usedBy.set(a[4].ref, []).get(a[4].ref)).push(a[3].ref);
  }
  const productOf = (rep) => {
    const pds = pdsOfRep.get(rep) ?? (linked.get(rep) || []).map((r) => pdsOfRep.get(r)).find((x) => x !== undefined);
    if (pds === undefined) return null;
    const e = file.get(pds);
    return e.type === 'PRODUCT_DEFINITION_SHAPE' && e.args[2] ? e.args[2].ref : null;
  };
  const count = (pd, depth = 0) => {
    if (depth > 20) throw new Unsupported('assembly loop');
    if (memo.has(pd)) return memo.get(pd);
    const parents = usedBy.get(pd);
    const n = parents ? parents.reduce((s, p) => s + count(p, depth + 1), 0) : 1;
    memo.set(pd, n);
    return n;
  };
  return (rep) => { const pd = productOf(rep); return pd === null ? 1 : count(pd); };
}

// Every solid in the file, measured straight from its geometry, with
// identical solids grouped like measureModel: { solids, groups }, or null when
// the file needs OpenCascade instead. opts.tol (mm) reads arcs finer and
// opts.profile keeps each solid's face loops, for toolpaths (api/_lib/cam.js).
export function measureStepText(text, rate, opts = {}) {
  const file = stepFile(text);
  if (!file || file.has('MAPPED_ITEM') || file.has('BREP_WITH_VOIDS')) return null;
  const breps = file.ids('MANIFOLD_SOLID_BREP');
  if (!breps.length) return null;
  try {
    const owner = new Map();
    for (const type of ['ADVANCED_BREP_SHAPE_REPRESENTATION', 'SHAPE_REPRESENTATION', 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION']) {
      for (const id of file.ids(type)) for (const item of file.get(id).args[1] || []) if (item) owner.set(item.ref, id);
    }
    const copiesOf = instanceCounter(file), readers = new Map(), groups = [];
    let solids = 0;
    for (const id of breps) {
      const rep = owner.get(id);
      if (rep === undefined) throw new Unsupported('solid outside a representation');
      const k = lengthUnit(file, file.get(rep).args[2]);
      const reader = readers.get(k) || readers.set(k, brepReader(file, k, opts.tol)).get(k);
      const shell = file.get(file.get(id).args[1]);
      if (shell.type !== 'CLOSED_SHELL') throw new Unsupported('open shell');
      const m = measureFaces(shell.args[1].map(reader.face), rate, opts.profile);
      const copies = copiesOf(rep);
      solids += copies;
      const g = groups.find((x) => sameShape(x.m, m));
      if (g) g.copies += copies; else groups.push({ m, copies });
    }
    return { solids, groups };
  } catch (err) {
    if (err instanceof Unsupported) return null;
    throw err;
  }
}

// ---- Whole model ----

export const cutLength = (m) => (m.contours || []).reduce((s, x) => s + x.length, 0);

// Every solid in the model, measured, with identical solids (several copies of
// one part in a file) grouped: { solids, groups: [{ m, copies }] }. A solid with
// no flat faces comes back without contours.
export function measureModel(meshes, rate) {
  const mesh = weld(meshes);
  const measured = solids(mesh).map((tris) => measureSolid(tris, mesh.verts, rate));
  const groups = [];
  for (const m of measured) {
    const g = groups.find((x) => sameShape(x.m, m));
    if (g) g.copies++; else groups.push({ m, copies: 1 });
  }
  return { solids: measured.length, groups };
}

// Two measured solids that are copies of one part.
function sameShape(a, b) {
  const close = (x, y) => Math.abs(x - y) <= 0.005 * Math.max(Math.abs(x), Math.abs(y), 1e-9);
  return close(a.volume, b.volume) && close(a.thickness || 0, b.thickness || 0) && close(a.rect?.length || 0, b.rect?.length || 0) &&
    close(a.rect?.width || 0, b.rect?.width || 0) && close(cutLength(a), cutLength(b));
}

// Machine time for one part, in minutes: each contour cut in depth passes,
// pockets cleared in stepover rows, plus setup and a plunge per round hole.
// rate: cncSetupMin, cncFeedIpm, cncPasses (for 1/8 in. stock; thicker stock
// scales from it), cncPerHoleMin, pocketStepoverIn.
export function passesFor(depth, rate) {
  const passDepth = (0.125 * MM_PER_IN) / rate.cncPasses;
  return Math.max(1, Math.ceil(depth / passDepth - 1e-6));
}
export function machineMinutes(m, rate) {
  let cut = 0, clear = 0, holes = 0;
  for (const x of m.contours) {
    cut += (x.length / MM_PER_IN) * passesFor(x.depth, rate) / rate.cncFeedIpm;
    if (x.type === 'pocket') clear += (x.area / MM_PER_IN ** 2) / (rate.pocketStepoverIn * rate.cncFeedIpm) * passesFor(x.depth, rate);
    if (x.type === 'hole') holes += rate.cncPerHoleMin;
  }
  return rate.cncSetupMin + cut + clear + holes;
}
