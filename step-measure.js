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
function minRect(points) {
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

  // Contours: the outline, then every opening in the top face or a pocket floor,
  // sorted into through holes, through cutouts and blind pockets by what lies under it.
  const contours = [];
  const topLoops = loopsOf(c.top);
  const outer = topLoops.reduce((x, y) => (Math.abs(y.area) > Math.abs(x.area) ? y : x), topLoops[0]);
  if (outer) contours.push({ type: 'outline', length: outer.length, depth: thickness, pts: outer.pts });
  const floorHeights = [...new Set(c.floors.map((x) => Math.round(x.h / c.tol)))].map((k) => c.floors.find((x) => Math.round(x.h / c.tol) === k).h);
  const levelLoops = [{ h: c.hi, loops: topLoops.filter((l) => l !== outer) }];
  for (const h of floorHeights) {
    const fl = loopsOf(c.floors.filter((x) => Math.abs(x.h - h) < c.tol).map((x) => x.f));
    const big = fl.reduce((x, y) => (Math.abs(y.area) > Math.abs(x.area) ? y : x), fl[0]);
    levelLoops.push({ h, loops: fl.filter((l) => l !== big), outline: big });
  }
  for (const { h, loops } of levelLoops) for (const l of loops) {
    const circle = fitCircle(l.pts);
    const floor = floorUnder(pointInside(l.pts, circle), h);
    const through = floor === null;
    contours.push({
      type: through ? (circle ? 'hole' : 'cutout') : 'pocket',
      // A round opening's length is its true circumference, not the mesh's polygon.
      length: circle ? 2 * Math.PI * circle.r : l.length, depth: through ? h - c.lo : h - floor,
      diameter: circle ? 2 * circle.r : null, area: Math.abs(l.area), pts: l.pts, from: c.hi - h
    });
  }

  // Anything a plain flat plate wouldn't have, as { id, text }.
  const flags = [];
  const flat = c.sloped <= 1e-4 * area + 0.5;
  if (!flat) flags.push({ id: 'sloped', text: 'Has sloped or curved faces (e.g. chamfers, fillets on top edges, or a 3D shape), so it isn\'t a plain 2D plate.' });
  if (c.under.length) flags.push({ id: 'both_sides', text: 'Has features cut into the bottom face: needs flipping and a second setup.' });
  if (!outer) flags.push({ id: 'no_outline', text: 'Couldn\'t find the top face\'s outline.' });
  // A pocket floor reaching past the top outline is a step around the outside
  // edge (a rabbet), which the cut length above doesn't include.
  const box = (pts) => pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  if (outer && levelLoops.slice(1).some(({ outline }) => {
    if (!outline) return false;
    const [a0, a1, a2, a3] = box(outer.pts), [b0, b1, b2, b3] = box(outline.pts);
    return b0 < a0 - 0.01 || b1 < a1 - 0.01 || b2 > a2 + 0.01 || b3 > a3 + 0.01;
  })) flags.push({ id: 'edge_step', text: 'Has a step cut around the outside edge: the cut length counts only the top outline, so check that step by hand.' });
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
    flat_plate: flat && !!outer, flags, contours, rect, area, volume: Math.abs(volume), thickness,
    stock: stock ? stock[1] : 'nonstandard',
    floors: levelLoops.slice(1).map(({ h, loops, outline }) => ({ depth: c.hi - h, loops: [outline, ...loops].filter(Boolean).map((l) => l.pts) })),
    topLoops: topLoops.map((l) => l.pts)
  };
}

// ---- Whole model ----

export const cutLength = (m) => (m.contours || []).reduce((s, x) => s + x.length, 0);

// Every solid in the model, measured, with identical solids (several copies of
// one part in a file) grouped: { solids, groups: [{ m, copies }] }. A solid with
// no flat faces comes back without contours.
export function measureModel(meshes, rate) {
  const mesh = weld(meshes);
  const measured = solids(mesh).map((tris) => measureSolid(tris, mesh.verts, rate));
  const close = (a, b) => Math.abs(a - b) <= 0.005 * Math.max(Math.abs(a), Math.abs(b), 1e-9);
  const groups = [];
  for (const m of measured) {
    const g = groups.find((x) => close(x.m.volume, m.volume) && close(x.m.thickness || 0, m.thickness || 0) &&
      close(x.m.rect?.length || 0, m.rect?.length || 0) && close(x.m.rect?.width || 0, m.rect?.width || 0) && close(cutLength(x.m), cutLength(m)));
    if (g) g.copies++; else groups.push({ m, copies: 1 });
  }
  return { solids: measured.length, groups };
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
