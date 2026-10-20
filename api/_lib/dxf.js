// DXF plates as closed loops, for toolpaths (api/_lib/cam.js). Reads the file
// the same way the quote page does (index.html parseDxf / resolveUnits: same
// entities, same unit guess), then joins the lines and arcs end to end into
// closed shapes, in millimeters. Arcs are split finely enough to stay within
// tol mm of the true curve.

const INSUNITS = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
const MM = { in: 25.4, ft: 304.8, mm: 1, cm: 10, m: 1000 };

// Entities as LINE, ARC or CIRCLE (polylines, splines and ellipses become
// those), in the file's own units, plus the declared unit if any.
function parseDxf(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i], 10), lines[i + 1].trim()]);
  let units = null;
  for (let u = 0; u + 2 < pairs.length; u++) {
    if (pairs[u][0] === 9 && pairs[u][1] === '$INSUNITS') { units = INSUNITS[parseInt(pairs[u + 1][1], 10)] || null; break; }
  }
  const raw = [];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] !== 0) continue;
    const item = { type: pairs[i][1], codes: [] };
    for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) item.codes.push(pairs[j]);
    raw.push(item);
  }
  const num = (item, code) => { const c = item.codes.find((x) => x[0] === code); return c ? parseFloat(c[1]) : 0; };
  const all = (item, code) => item.codes.filter((x) => x[0] === code).map((x) => parseFloat(x[1]));

  const entities = [];
  const addLine = (x1, y1, x2, y2) => { if (x1 !== x2 || y1 !== y2) entities.push({ type: 'LINE', x1, y1, x2, y2 }); };
  // A polyline segment with a bulge is an arc: bulge = tan(sweep / 4), positive counterclockwise.
  const addSegment = (p, q, bulge) => {
    if (!bulge) return addLine(p.x, p.y, q.x, q.y);
    const c = Math.hypot(q.x - p.x, q.y - p.y);
    if (!c) return;
    const s = c / 2, h = Math.abs(bulge) * s, r = (s * s + h * h) / (2 * h);
    let nx = -(q.y - p.y) / c, ny = (q.x - p.x) / c;
    if (bulge < 0) { nx = -nx; ny = -ny; }
    const cx = (p.x + q.x) / 2 + nx * (r - h), cy = (p.y + q.y) / 2 + ny * (r - h);
    const ap = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI, aq = Math.atan2(q.y - cy, q.x - cx) * 180 / Math.PI;
    entities.push(bulge > 0 ? { type: 'ARC', cx, cy, r, a1: ap, a2: aq } : { type: 'ARC', cx, cy, r, a1: aq, a2: ap });
  };
  const addPolyline = (pts, closed) => {
    for (let k = 0; k + 1 < pts.length; k++) addSegment(pts[k], pts[k + 1], pts[k].b);
    if (closed && pts.length > 2) addSegment(pts[pts.length - 1], pts[0], pts[pts.length - 1].b);
  };
  for (let n = 0; n < raw.length; n++) {
    const e = raw[n], t = e.type;
    if (t === 'LINE') addLine(num(e, 10), num(e, 20), num(e, 11), num(e, 21));
    else if (t === 'CIRCLE') entities.push({ type: 'CIRCLE', cx: num(e, 10), cy: num(e, 20), r: num(e, 40) });
    else if (t === 'ARC') entities.push({ type: 'ARC', cx: num(e, 10), cy: num(e, 20), r: num(e, 40), a1: num(e, 50), a2: num(e, 51) });
    else if (t === 'LWPOLYLINE') {
      const pts = [];
      let cur = null;
      for (const c of e.codes) {
        if (c[0] === 10) { cur = { x: parseFloat(c[1]), y: 0, b: 0 }; pts.push(cur); } else if (c[0] === 20 && cur) cur.y = parseFloat(c[1]); else if (c[0] === 42 && cur) cur.b = parseFloat(c[1]);
      }
      addPolyline(pts, (num(e, 70) & 1) === 1);
    } else if (t === 'POLYLINE') {
      const vpts = [];
      while (n + 1 < raw.length && raw[n + 1].type === 'VERTEX') { n++; vpts.push({ x: num(raw[n], 10), y: num(raw[n], 20), b: num(raw[n], 42) }); }
      addPolyline(vpts, (num(e, 70) & 1) === 1);
    } else if (t === 'SPLINE') {
      // Straight runs through the fit points, or the control points (as the quote page does).
      const fx = all(e, 11), fy = all(e, 21), xs = fx.length > 1 ? fx : all(e, 10), ys = fx.length > 1 ? fy : all(e, 20);
      for (let k = 0; k + 1 < Math.min(xs.length, ys.length); k++) addLine(xs[k], ys[k], xs[k + 1], ys[k + 1]);
    } else if (t === 'ELLIPSE') {
      const ecx = num(e, 10), ecy = num(e, 20), mx = num(e, 11), my = num(e, 21), ratio = num(e, 40) || 1;
      const p0 = num(e, 41);
      let p1 = all(e, 42).length ? num(e, 42) : Math.PI * 2;
      if (p1 <= p0) p1 += Math.PI * 2;
      const steps = Math.max(8, Math.ceil((p1 - p0) / (Math.PI * 2) * 256));
      let prev = null;
      for (let k = 0; k <= steps; k++) {
        const a = p0 + (p1 - p0) * k / steps, ca = Math.cos(a), sa = Math.sin(a) * ratio;
        const pt = { x: ecx + mx * ca - my * sa, y: ecy + my * ca + mx * sa };
        if (prev) addLine(prev.x, prev.y, pt.x, pt.y);
        prev = pt;
      }
    }
  }
  return { entities, units };
}

const arcSweep = (e) => { const s = ((e.a2 - e.a1) % 360 + 360) % 360; return s === 0 ? 360 : s; };

// The quote page's unit rule: the declared unit, or inches up to 40 units across, else mm.
function unitsOf(entities, declared) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const bound = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const e of entities) {
    if (e.type === 'LINE') { bound(e.x1, e.y1); bound(e.x2, e.y2); continue; }
    if (e.type === 'CIRCLE') { bound(e.cx - e.r, e.cy - e.r); bound(e.cx + e.r, e.cy + e.r); continue; }
    // An arc counts only its drawn part: both ends, and any compass point it passes.
    const a1 = ((e.a1 % 360) + 360) % 360, sweep = arcSweep(e), at = (a) => bound(e.cx + e.r * Math.cos(a * Math.PI / 180), e.cy + e.r * Math.sin(a * Math.PI / 180));
    at(a1); at(a1 + sweep);
    for (let q = 0; q < 720; q += 90) if (q > a1 && q < a1 + sweep) at(q);
  }
  if (!isFinite(x0)) return null;
  const units = declared || (Math.max(x1 - x0, y1 - y0) > 40 ? 'mm' : 'in');
  return { units, toMm: MM[units] || 25.4, guessed: !declared };
}

// Points along an arc from angle a (degrees) through sweep degrees, at most tol mm off the curve.
function arcPoints(cx, cy, r, a, sweep, tol) {
  const step = Math.min(0.1, 2 * Math.acos(Math.max(0, 1 - tol / r)));
  const n = Math.max(2, Math.ceil(Math.abs(sweep * Math.PI / 180) / step));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = (a + sweep * i / n) * Math.PI / 180;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

const signedArea = (pts) => {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return s / 2;
};
const inside = (p, pts) => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

// The plate(s) in a DXF: { outlines, holes, units, guessed, open }, loops as
// { pts: [[x, y], ...] (mm, not repeating the first point), circle: { c, r } | null }.
// Outlines are the outer edges of parts; holes are the openings in them
// (a loop inside a hole is another part's outline). open counts shapes that
// don't close, which can't be cut and are left out. null when nothing's drawn.
export function dxfProfile(text, { tol = 0.005 } = {}) {
  const { entities, units: declared } = parseDxf(text);
  const u = unitsOf(entities, declared);
  if (!u) return null;
  const k = u.toMm;
  const loops = [], segs = [];
  for (const e of entities) {
    if (e.type === 'CIRCLE' || (e.type === 'ARC' && arcSweep(e) === 360)) {
      if (!(e.r > 0)) continue;
      const pts = arcPoints(e.cx * k, e.cy * k, e.r * k, 0, 360, tol);
      pts.pop();
      loops.push({ pts, circle: { c: [e.cx * k, e.cy * k], r: e.r * k } });
    } else if (e.type === 'LINE') {
      segs.push([[e.x1 * k, e.y1 * k], [e.x2 * k, e.y2 * k]]);
    } else if (e.type === 'ARC' && e.r > 0) {
      segs.push(arcPoints(e.cx * k, e.cy * k, e.r * k, e.a1, arcSweep(e), tol));
    }
  }

  // Join segments end to end (ends within 0.01 mm), into closed loops.
  const JOIN = 0.01, cell = (p) => `${Math.round(p[0] / JOIN)},${Math.round(p[1] / JOIN)}`;
  const ends = new Map();
  const near = (p) => {
    const [cx, cy] = [Math.round(p[0] / JOIN), Math.round(p[1] / JOIN)], out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(ends.get(`${cx + dx},${cy + dy}`) || []));
    return out;
  };
  segs.forEach((s, i) => {
    for (const [end, p] of [[0, s[0]], [1, s[s.length - 1]]]) (ends.get(cell(p)) || ends.set(cell(p), []).get(cell(p))).push({ i, end, p });
  });
  const used = new Array(segs.length).fill(false);
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= JOIN;
  let open = 0;
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const pts = segs[i].slice();
    let closed = close(pts[0], pts[pts.length - 1]) && pts.length > 2;
    while (!closed) {
      const tail = pts[pts.length - 1];
      const next = near(tail).find((x) => !used[x.i] && close(x.p, tail));
      if (!next) break;
      used[next.i] = true;
      const s = next.end === 0 ? segs[next.i] : segs[next.i].slice().reverse();
      for (let j = 1; j < s.length; j++) pts.push(s[j]);
      closed = close(pts[0], pts[pts.length - 1]);
    }
    if (!closed) { open++; continue; }
    pts.pop();
    if (pts.length >= 3 && Math.abs(signedArea(pts)) > 1e-6) loops.push({ pts, circle: null });
  }

  // Even nesting depth: a part's outer edge. Odd: an opening in the part around it.
  const area = loops.map((l) => Math.abs(signedArea(l.pts)));
  const outlines = [], holes = [];
  loops.forEach((l, i) => {
    const p = l.pts[0];
    const depth = loops.filter((o, j) => j !== i && area[j] > area[i] && inside(p, o.pts)).length;
    (depth % 2 ? holes : outlines).push(l);
  });
  return { outlines, holes, units: u.units, guessed: u.guessed, open };
}
