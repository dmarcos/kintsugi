// Shared by index.html (the collection) and explanation.html (the making-of walkthrough).
import * as THREE from 'three';

// ==== CORE BEGIN ===========================================================
// Procedural pottery: revolved profiles, baked PBR glaze maps, gold seams.

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const nextFrame = () => new Promise((r) => (globalThis.requestAnimationFrame || setTimeout)(r));

// Hooks for the walkthrough: record the fracture planes and chords a build() uses, and scale
// the crack roughness (0 gives the ideal, smooth break).
const trace = { planes: null, chords: null, ampScale: 1 };

// ---- noise -----------------------------------------------------------------

function hashi(x, y, z, seed) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1) ^ Math.imul(seed, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const hash3 = (x, y, z, s) => hashi(x, y, z, s) / 4294967296;

function noise3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c000 = hash3(xi, yi, zi, seed), c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed), c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed), c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed), c111 = hash3(xi + 1, yi + 1, zi + 1, seed);
  const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

function fbm3(x, y, z, oct = 4, seed = 0) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise3(x, y, z, seed + i * 17);
    n += a; a *= 0.5; x *= 2.03; y *= 2.03; z *= 2.03;
  }
  return s / n;
}

// Distance-to-cell-edge (F2 - F1) of a 3D Voronoi field: crackle glaze lines.
function cellEdge3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let f1 = 9, f2 = 9;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz;
    const h = hashi(cx, cy, cz, seed);
    const px = cx + (h & 1023) / 1024 - x, py = cy + ((h >>> 10) & 1023) / 1024 - y, pz = cz + ((h >>> 20) & 1023) / 1024 - z;
    const d = px * px + py * py + pz * pz;
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return Math.sqrt(f2) - Math.sqrt(f1);
}

function noise1(x, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return (hash3(i, 0, 0, seed) * (1 - u) + hash3(i + 1, 0, 0, seed) * u) * 2 - 1;
}
function noise1Lin(x, seed) {
  const i = Math.floor(x), f = x - i;
  return (hash3(i, 0, 0, seed) * (1 - f) + hash3(i + 1, 0, 0, seed) * f) * 2 - 1;
}

// Fracture wander: slow drift + small kinks + angular jaggedness.
const jitLow = (l, seed) => 0.02 * noise1(l * 1.3, seed) + 0.007 * noise1(l * 5.5, seed + 1);
const jitHigh = (l, seed) => 0.0026 * noise1(l * 20, seed + 2) + 0.0011 * noise1Lin(l * 62, seed + 3);

const setC = (o, r, g, b) => { o.c[0] = r; o.c[1] = g; o.c[2] = b; };
const blendC = (o, r, g, b, t) => { o.c[0] += (r - o.c[0]) * t; o.c[1] += (g - o.c[1]) * t; o.c[2] += (b - o.c[2]) * t; };

// ---- surface of revolution -------------------------------------------------
// A profile (r, y) runs from the bottom pole, out along the underside, over the lip,
// and back along the inside to the top pole. s ∈ [0,1] is arc length along it.

class Revolved {
  constructor(ctrl, { samples = 480, warp = null, ripple = null, lipBy = 'y' } = {}) {
    this.ctrl = ctrl;
    const curve = new THREE.CatmullRomCurve3(ctrl.map(([r, y]) => new THREE.Vector3(r, y, 0)), false, 'centripetal');
    const pts = curve.getSpacedPoints(samples);
    const N = (this.N = samples);
    this.length = curve.getLength();
    this.r = new Float32Array(N + 1); this.y = new Float32Array(N + 1);
    this.nr = new Float32Array(N + 1); this.ny = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) {
      this.r[i] = Math.max(0, pts[i].x);
      this.y[i] = pts[i].y;
      if (ripple) this.r[i] += ripple(this.r[i], this.y[i], i / N);
    }
    this.r[0] = 0; this.r[N] = 0;
    for (let i = 0; i <= N; i++) {
      const a = Math.max(i - 1, 0), b = Math.min(i + 1, N);
      const dr = this.r[b] - this.r[a], dy = this.y[b] - this.y[a];
      const l = Math.hypot(dr, dy) || 1;
      this.nr[i] = dy / l; this.ny[i] = -dr / l;
    }
    this.nr[0] = 0; this.ny[0] = -1; this.nr[N] = 0; this.ny[N] = 1;
    const key = lipBy === 'r' ? this.r : this.y;
    this.iLip = 0;
    for (let i = 1; i <= N; i++) if (key[i] > key[this.iLip]) this.iLip = i;
    this.sLip = this.iLip / N;
    this.rMax = Math.max(...this.r);
    this.warp = warp;
  }

  sample(s, o = {}) {
    const f = clamp(s) * this.N, i = Math.min(Math.floor(f), this.N - 1), t = f - i;
    o.r = mix(this.r[i], this.r[i + 1], t); o.y = mix(this.y[i], this.y[i + 1], t);
    o.nr = mix(this.nr[i], this.nr[i + 1], t); o.ny = mix(this.ny[i], this.ny[i + 1], t);
    o.s = s; o.inner = f > this.iLip;
    return o;
  }

  point(s, th, P, Nm) {
    const o = this.sample(s, this._tmp || (this._tmp = {}));
    let r = o.r, y = o.y;
    if (this.warp) { const w = this.warp(th, r, y); r *= w[0]; y += w[1]; }
    const c = Math.cos(th), si = Math.sin(th);
    P.set(r * c, y, r * si);
    if (Nm) Nm.set(o.nr * c, o.ny, o.nr * si).normalize();
    return P;
  }

  // First s where the profile crosses `value` (on 'r' or 'y'), walking away from the lip.
  sAt(branch, key, value) {
    const arr = key === 'r' ? this.r : this.y, L = this.iLip, N = this.N;
    if (branch === 'inner') {
      for (let i = L; i < N; i++) {
        const a = arr[i] - value, b = arr[i + 1] - value;
        if (a === 0) return i / N;
        if (a * b < 0) return (i + a / (a - b)) / N;
      }
      return 1;
    }
    for (let i = L; i > 0; i--) {
      const a = arr[i] - value, b = arr[i - 1] - value;
      if (a === 0) return i / N;
      if (a * b < 0) return (i - a / (a - b)) / N;
    }
    return 0;
  }

  geometry(segT, uvMode) {
    const N = this.N, cols = segT + 1, count = (N + 1) * cols;
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    const P = new THREE.Vector3(), Nm = new THREE.Vector3(), R = this.rMax * 1.03;
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= segT; j++) {
        const k = i * cols + j;
        this.point(i / N, (j / segT) * TAU, P, Nm);
        P.toArray(pos, k * 3); Nm.toArray(nor, k * 3);
        if (uvMode === 'planar') { uv[k * 2] = P.x / (2 * R) + 0.5; uv[k * 2 + 1] = P.z / (2 * R) + 0.5; }
        else { uv[k * 2] = j / segT; uv[k * 2 + 1] = i / N; }
      }
    }
    const idx = new Uint32Array(N * segT * 6);
    let p = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < segT; j++) {
      const a = i * cols + j, b = a + cols, c = b + 1, d = a + 1;
      idx[p++] = a; idx[p++] = b; idx[p++] = d;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ---- crack paths (in surface parameters s, θ) ------------------------------

const wrapAngle = (a) => a - TAU * Math.round(a / TAU);
const unwrap = (pts) => { for (let i = 1; i < pts.length; i++) pts[i][1] = pts[i - 1][1] + wrapAngle(pts[i][1] - pts[i - 1][1]); return pts; };
const unwarpedPoint = (surf, [s, th], out = new THREE.Vector3(), smp = {}) => {
  surf.sample(s, smp);
  return out.set(smp.r * Math.cos(th), smp.y, smp.r * Math.sin(th));
};

// Resample a dense (s, θ) polyline by true 3D arc length, then roughen it with fracture wander.
function roughen(surf, pts, { closed = false, seed = 1, amp = 0.7, step = 0.004 } = {}) {
  const src = closed ? [...pts, [pts[0][0], pts[pts.length - 1][1] + wrapAngle(pts[0][1] - pts[pts.length - 1][1])]] : pts;
  const P = new THREE.Vector3(), Q = new THREE.Vector3(), acc = [0];
  surf.point(src[0][0], src[0][1], Q);
  for (let i = 1; i < src.length; i++) { surf.point(src[i][0], src[i][1], P); acc.push(acc[i - 1] + P.distanceTo(Q)); Q.copy(P); }
  const total = acc[acc.length - 1], n = Math.max(4, Math.round(total / step)), out = [];
  let k = 0;
  for (let m = 0; m <= (closed ? n - 1 : n); m++) {
    const target = (m / n) * total;
    while (k < src.length - 2 && acc[k + 1] < target) k++;
    const t = clamp((target - acc[k]) / (acc[k + 1] - acc[k] || 1));
    out.push([mix(src[k][0], src[k + 1][0], t), mix(src[k][1], src[k + 1][1], t), target]);
  }
  const L = surf.length, smp = {}, cnt = out.length;
  const res = out.map(([s, th, l], m) => {
    const a = out[closed ? (m - 1 + cnt) % cnt : Math.max(m - 1, 0)], b = out[closed ? (m + 1) % cnt : Math.min(m + 1, cnt - 1)];
    const r = Math.max(surf.sample(s, smp).r, 0.03);
    let tx = (b[0] - a[0]) * L, ty = wrapAngle(b[1] - a[1]) * r;
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const j = (x) => trace.ampScale * (amp * jitLow(x, seed) + jitHigh(x, seed));
    let d = j(l);
    if (closed) d = mix(d, j(l - total), smoothstep(total - 0.1, total, l));
    else d *= smoothstep(0, 0.03, l) * smoothstep(0, 0.03, total - l);
    return [clamp(s + (-ty * d) / L, 0.0005, 0.9995), th + (tx * d) / r];
  });
  return { pts: res, closed };
}

// ---- fracture planes ----------------------------------------------------------
// Real breaks run roughly perpendicular to the wall and nearly straight through the body,
// so each crack starts as the section of the vessel by a plane, then gets roughened.

// Plane through two surface points that contains the wall normal between them.
function planeThrough(surf, p1, p2) {
  const smp = {}, A = unwarpedPoint(surf, p1), B = unwarpedPoint(surf, p2);
  surf.sample((p1[0] + p2[0]) / 2, smp);
  const tm = p1[1] + wrapAngle(p2[1] - p1[1]) / 2;
  const N = new THREE.Vector3(smp.nr * Math.cos(tm), smp.ny, smp.nr * Math.sin(tm));
  const n = new THREE.Vector3().subVectors(B, A).cross(N).normalize();
  const plane = { n, d: n.dot(A) };
  trace.planes?.push({ ...plane, A, B });
  return plane;
}

// Closed (s, θ) loops where n·P = d on the surface. Each profile circle meets the plane
// at θ = φ ± acos(k); the + and − branches join where |k| = 1.
function planeLoops(surf, { n, d }, steps = 1600) {
  const smp = {}, h = Math.hypot(n.x, n.z), phi = Math.atan2(n.z, n.x);
  const k = (s) => { surf.sample(s, smp); return (d - n.y * smp.y) / Math.max(smp.r * h, 1e-6); };
  const inside = (s) => Math.abs(k(s)) <= 1;
  const edge = (a, b) => { for (let i = 0; i < 32; i++) { const m = (a + b) / 2; if (inside(m)) a = m; else b = m; } return a; };
  const at = (s, sg) => [s, phi + sg * Math.acos(clamp(k(s), -1, 1))];
  const loops = [];
  let plus = null, minus = null, prev = 0;
  const finish = (sEnd) => {
    if (sEnd !== null) plus.push(at(sEnd, 1));
    const pts = [...plus, ...minus.reverse()];
    if (pts.length > 8) loops.push(unwrap(pts));
    plus = null;
  };
  for (let i = 0; i <= steps; i++) {
    const s = i / steps, ins = inside(s);
    if (ins && !plus) { plus = []; minus = []; if (i > 0) plus.push(at(edge(s, prev), 1)); }
    if (ins) { plus.push(at(s, 1)); minus.push(at(s, -1)); }
    else if (plus) finish(edge(prev, s));
    prev = s;
  }
  if (plus) finish(null);
  return loops;
}

// Keep only the parts of each run where test(P) holds (P on the unwarped surface).
function clipRuns(surf, runs, test) {
  const out = [], smp = {}, P = new THREE.Vector3();
  for (const run of runs) {
    let pts = run.pts, ok = pts.map((p) => test(unwarpedPoint(surf, p, P, smp)));
    if (ok.every(Boolean)) { out.push(run); continue; }
    if (run.closed) { const k = ok.indexOf(false); pts = [...pts.slice(k), ...pts.slice(0, k)]; ok = [...ok.slice(k), ...ok.slice(0, k)]; }
    let cur = [];
    for (let i = 0; i <= pts.length; i++) {
      if (i < pts.length && ok[i]) cur.push([...pts[i]]);
      else { if (cur.length > 8) out.push({ pts: unwrap(cur), closed: false }); cur = []; }
    }
  }
  return out;
}

const sideOf = (surf, { n, d }, ref, margin = 0) => {
  const sg = Math.sign(n.dot(unwarpedPoint(surf, ref)) - d);
  return (P) => sg * (n.dot(P) - d) > margin;
};
const above = (y) => (P) => P.y > y;
// Half of the vessel facing direction θ (keeps a crack from wrapping round to the far side).
const facing = (th, off = 0.03) => (P) => P.x * Math.cos(th) + P.z * Math.sin(th) > off;

// A crack along the plane through p1 and p2, clipped by `keep`, taking the run nearest `near`.
function fracture(surf, plane, { keep = [], near, seed = 1, amp = 0.7 }) {
  let runs = planeLoops(surf, plane).map((pts) => ({ pts, closed: true }));
  for (const test of keep) runs = clipRuns(surf, runs, test);
  const P = unwarpedPoint(surf, near), Q = new THREE.Vector3(), smp = {};
  let best = null, bd = Infinity;
  for (const run of runs) for (const p of run.pts) {
    const dd = unwarpedPoint(surf, p, Q, smp).distanceToSquared(P);
    if (dd < bd) { bd = dd; best = run; }
  }
  return roughen(surf, best.pts, { closed: best.closed, seed, amp });
}

// Join the free ends of a branch onto the crack it stops against (a T-junction).
function snapTo(surf, path, target, reach = 0.06) {
  if (path.closed) return path;
  const P = new THREE.Vector3(), Q = new THREE.Vector3();
  path.join = path.join || [false, false];
  for (const end of [0, 1]) {
    const p = end ? path.pts[path.pts.length - 1] : path.pts[0];
    surf.point(p[0], p[1], P);
    let best = null, bd = reach * reach;
    for (const q of target.pts) { const dd = surf.point(q[0], q[1], Q).distanceToSquared(P); if (dd < bd) { bd = dd; best = q; } }
    if (!best) continue;
    const q = [best[0], p[1] + wrapAngle(best[1] - p[1])];
    if (end) path.pts.push(q); else path.pts.unshift(q);
    path.join[end] = true;
  }
  return path;
}

// Through-crack across a plate/bowl seen from above: a chord over the inside,
// over the lip, back along the underside, over the lip again. Returns a closed loop.
function chordCrack(surf, { thA, thB, ctrl, rEnd, seed = 1, amp = 1, step = 0.004 }) {
  const A = new THREE.Vector2(Math.cos(thA), Math.sin(thA)).multiplyScalar(rEnd);
  const B = new THREE.Vector2(Math.cos(thB), Math.sin(thB)).multiplyScalar(rEnd);
  const bez = new THREE.QuadraticBezierCurve(A, new THREE.Vector2(ctrl[0], ctrl[1]), B);
  trace.chords?.push({ A, B, ctrl, rEnd });
  amp *= trace.ampScale;
  const len = bez.getLength(), n = Math.max(8, Math.round(len / step));
  const base = bez.getSpacedPoints(n);
  const toS = (x, z, branch) => [surf.sAt(branch, 'r', Math.min(Math.hypot(x, z), rEnd)), Math.atan2(z, x)];
  const top = [], bot = [], plan = [];
  for (let i = 0; i <= n; i++) {
    const l = (i / n) * len, p = base[i], q = base[Math.min(i + 1, n)], q0 = base[Math.max(i - 1, 0)];
    let tx = q.x - q0.x, tz = q.y - q0.y;
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    const taper = smoothstep(0, 0.06, l) * smoothstep(0, 0.06, len - l);
    const shared = amp * jitLow(l, seed) * taper;
    const dT = shared + amp * jitHigh(l, seed + 100) * taper;
    const dB = shared + amp * jitHigh(l, seed + 200) * taper;
    plan.push([p.x - tz * dT, p.y + tx * dT]);
    top.push(toS(p.x - tz * dT, p.y + tx * dT, 'inner'));
    bot.push(toS(p.x - tz * dB, p.y + tx * dB, 'outer'));
  }
  const sI = surf.sAt('inner', 'r', rEnd), sO = surf.sAt('outer', 'r', rEnd);
  const m = Math.max(3, Math.ceil(((sI - sO) * surf.length) / step));
  const lipB = [], lipA = [];
  for (let k = 1; k < m; k++) {
    lipB.push([mix(sI, sO, k / m), top[n][1]]);
    lipA.push([mix(sO, sI, k / m), top[0][1]]);
  }
  return { paths: [{ pts: [...top, ...lipB, ...bot.reverse(), ...lipA], closed: true }], plan };
}

// ---- gold seam geometry -----------------------------------------------------
// A raised, slightly flattened lacquer bead swept along the crack on the surface.

function buildBead(surf, paths, { width, height, seed = 3, ao = null }) {
  const RAD = 12;
  const pos = [], uvs = [], cols = [], idx = [];
  const P = new THREE.Vector3(), Nm = new THREE.Vector3(), T = new THREE.Vector3(), B = new THREE.Vector3(), V = new THREE.Vector3();
  const smp = {};
  for (const path of paths) {
    const pts = path.pts, n = pts.length, closed = path.closed;
    const Ps = [], Ns = [];
    for (const [s, th] of pts) {
      const n3 = new THREE.Vector3();
      Ps.push(surf.point(s, th, new THREE.Vector3(), n3));
      Ns.push(n3);
    }
    const acc = [0];
    for (let i = 1; i < n; i++) acc.push(acc[i - 1] + Ps[i].distanceTo(Ps[i - 1]));
    const total = acc[n - 1];
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const a = closed ? (i - 1 + n) % n : Math.max(i - 1, 0), b = closed ? (i + 1) % n : Math.min(i + 1, n - 1);
      T.subVectors(Ps[b], Ps[a]).normalize();
      Nm.copy(Ns[i]).addScaledVector(T, -Ns[i].dot(T)).normalize();
      B.crossVectors(T, Nm).normalize();
      Nm.crossVectors(B, T);
      const l = acc[i];
      const join = path.join || [false, false];
      const taper = closed ? 1 : Math.sqrt((join[0] ? 1 : smoothstep(0, 0.04, l)) * (join[1] ? 1 : smoothstep(0, 0.04, total - l)));
      const w = width * (0.8 + 0.22 * noise1(l * 9, seed) + 0.1 * noise1Lin(l * 45, seed + 1)) * taper;
      const h = height * (0.85 + 0.2 * noise1(l * 13, seed + 2)) * taper;
      const shade = ao ? mix(0.55, 1, clamp(ao(surf.sample(pts[i][0], smp)))) : 1;
      for (let k = 0; k <= RAD; k++) {
        const ang = (k / RAD) * TAU, ca = Math.cos(ang), sa = Math.sin(ang);
        const up = sa > 0 ? Math.pow(sa, 0.65) * h : sa * h * 1.2;
        V.copy(Ps[i]).addScaledVector(B, ca * w).addScaledVector(Nm, up - h * 0.25);
        pos.push(V.x, V.y, V.z);
        uvs.push(l / 0.3, k / RAD);
        cols.push(shade, shade, shade);
      }
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const i1 = (i + 1) % n;
      for (let k = 0; k < RAD; k++) {
        const a = base + i * (RAD + 1) + k, b = base + i1 * (RAD + 1) + k, c = b + 1, d = a + 1;
        idx.push(a, b, d, b, c, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---- texture baking -----------------------------------------------------------
// Each piece supplies shade(P, o): P = point on the unwarped surface, o = material sample.
// Output is packed glTF-style: color (sRGB), ORM (ao, roughness, metalness), clearcoat, normal.

async function bakeMaps(piece, { budget = 10, onProgress } = {}) {
  const { w, h, uv, normalStrength = 3 } = piece.tex;
  const surf = piece.surf, cyl = uv === 'cyl';
  const color = new Uint8ClampedArray(w * h * 4), orm = new Uint8ClampedArray(w * h * 4);
  const coat = new Uint8ClampedArray(w * h * 4), nrm = new Uint8ClampedArray(w * h * 4);
  const height = new Float32Array(w * h);
  const o = { c: [0, 0, 0], rough: 0.5, metal: 0, ao: 1, coat: 1, height: 0 };
  const P = { x: 0, y: 0, z: 0, r: 0, th: 0, s: 0, inner: false };
  const smp = {}, R = surf.rMax * 1.03;
  let deadline = performance.now() + budget;
  const yieldMaybe = async (f) => {
    if (performance.now() > deadline) { onProgress?.(f); await nextFrame(); deadline = performance.now() + budget; }
  };
  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) / h;
    if (cyl) { surf.sample(v, smp); P.s = v; P.inner = smp.inner; P.r = smp.r; P.y = smp.y; }
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w;
      if (cyl) { P.th = u * TAU; P.x = P.r * Math.cos(P.th); P.z = P.r * Math.sin(P.th); }
      else { P.x = (u - 0.5) * 2 * R; P.z = (v - 0.5) * 2 * R; P.r = Math.hypot(P.x, P.z); P.th = Math.atan2(P.z, P.x); }
      o.rough = 0.5; o.metal = 0; o.coat = 1; o.height = 0;
      o.ao = piece.ao ? piece.ao(P) : 1;
      piece.shade(P, o);
      const k = (j * w + i) * 4;
      color[k] = o.c[0] * 255; color[k + 1] = o.c[1] * 255; color[k + 2] = o.c[2] * 255; color[k + 3] = 255;
      orm[k] = o.ao * 255; orm[k + 1] = o.rough * 255; orm[k + 2] = o.metal * 255; orm[k + 3] = 255;
      coat[k] = coat[k + 1] = coat[k + 2] = o.coat * 255; coat[k + 3] = 255;
      height[j * w + i] = o.height;
    }
    await yieldMaybe((j / h) * 0.85);
  }
  for (let j = 0; j < h; j++) {
    const ju = Math.max(j - 1, 0) * w, jd = Math.min(j + 1, h - 1) * w, jr = j * w;
    for (let i = 0; i < w; i++) {
      const il = cyl ? (i - 1 + w) % w : Math.max(i - 1, 0), ir = cyl ? (i + 1) % w : Math.min(i + 1, w - 1);
      const dx = (height[jr + ir] - height[jr + il]) * normalStrength;
      const dy = (height[jd + i] - height[ju + i]) * normalStrength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1), k = (jr + i) * 4;
      nrm[k] = (-dx * inv * 0.5 + 0.5) * 255; nrm[k + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      nrm[k + 2] = (inv * 0.5 + 0.5) * 255; nrm[k + 3] = 255;
    }
    await yieldMaybe(0.85 + (j / h) * 0.15);
  }
  onProgress?.(1);
  return { color, orm, coat, nrm, w, h };
}

// Burnished gold powder over urushi: fine granular roughness, lacquer showing at the bead edges.
function bakeGold() {
  const w = 512, h = 64;
  const color = new Uint8ClampedArray(w * h * 4), orm = new Uint8ClampedArray(w * h * 4), nrm = new Uint8ClampedArray(w * h * 4);
  const height = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) / h;
    const side = v < 0.5 ? 1 - smoothstep(0.02, 0.11, Math.min(v, 0.5 - v)) : 1;
    for (let i = 0; i < w; i++) {
      const a = ((i + 0.5) / w) * TAU, ca = Math.cos(a), sa = Math.sin(a);
      const g = fbm3(ca * 16, v * 34, sa * 16, 3, 81);
      const gl = fbm3(ca * 2.2, v * 3, sa * 2.2, 2, 83);
      const k = (j * w + i) * 4;
      const br = 0.92 + 0.16 * (gl - 0.5) + 0.08 * (g - 0.5);
      color[k] = mix(br, 0.66, side * 0.25) * 255;
      color[k + 1] = mix(br, 0.4, side * 0.25) * 255;
      color[k + 2] = mix(br, 0.26, side * 0.25) * 255;
      color[k + 3] = 255;
      orm[k] = 255; orm[k + 1] = clamp(0.15 + 0.16 * g + 0.12 * side + 0.06 * gl) * 255; orm[k + 2] = 255; orm[k + 3] = 255;
      height[j * w + i] = g;
    }
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const dx = (height[j * w + ((i + 1) % w)] - height[j * w + ((i - 1 + w) % w)]) * 5;
    const dy = (height[Math.min(j + 1, h - 1) * w + i] - height[Math.max(j - 1, 0) * w + i]) * 5;
    const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1), k = (j * w + i) * 4;
    nrm[k] = (-dx * inv * 0.5 + 0.5) * 255; nrm[k + 1] = (-dy * inv * 0.5 + 0.5) * 255; nrm[k + 2] = (inv * 0.5 + 0.5) * 255; nrm[k + 3] = 255;
  }
  return { color, orm, nrm, w, h };
}

// ---- the collection -------------------------------------------------------------

const PIECES = [
  {
    name: 'Ai Tenmoku Sara', jp: '藍天目皿', tag: 'Reference',
    meta: 'Stoneware plate · Ø 25 cm · indigo tenmoku',
    desc: 'Deep indigo tenmoku with pale oil-spot crystals gathering toward the rim. A single clean fracture, rejoined with urushi and finished in pure gold.',
    build() {
      const yt = (r) => 0.062 + 0.13 * Math.pow(r, 2.4);
      const ctrl = [[0, 0.032], [0.18, 0.032], [0.33, 0.034], [0.365, 0.029], [0.385, 0.01], [0.4, 0], [0.45, 0], [0.463, 0.012], [0.475, 0.04]];
      for (let r = 0.53; r < 0.94; r += 0.05) ctrl.push([r, yt(r) - 0.03]);
      const cx = 0.982, cy = yt(cx) - 0.015, rad = 0.016;
      for (let a = -80; a <= 80; a += 20) ctrl.push([cx + rad * Math.cos(a * D2R), cy + rad * Math.sin(a * D2R)]);
      for (let r = 0.95; r > 0.02; r -= 0.05) ctrl.push([r, yt(r)]);
      ctrl.push([0, yt(0)]);
      const warp = (th, r) => {
        const k = r * r;
        return [1 + (0.005 * Math.sin(2 * th + 1.1) + 0.003 * Math.sin(3 * th + 2.3) + 0.0015 * Math.sin(7 * th + 0.4)) * k,
          0.012 * Math.sin(2 * th + 0.4) * k * r];
      };
      const surf = new Revolved(ctrl, { samples: 560, warp, lipBy: 'r' });
      // Matches the photographed break: enters top-right, bows past the centre, exits lower-left.
      const { paths } = chordCrack(surf, { thA: Math.atan2(-0.99, 0.23), thB: Math.atan2(0.65, -0.78), ctrl: [0.27, 0.24], rEnd: 0.975, seed: 7 });
      return {
        surf, cracks: paths, segT: 320,
        tex: { w: 2048, h: 2048, uv: 'planar', normalStrength: 4.5 },
        coat: { clearcoat: 0.45, roughness: 0.26 }, normalScale: 0.6,
        gold: { width: 0.0105, height: 0.0032, seed: 3 },
        mount: 'stand', motion: 'sway', view: { r: 5.4, phi: 1.36 },
        shade(P, o) {
          const { x, z, r } = P;
          const m = fbm3(x * 2.2 + 7.3, 0.5, z * 2.2 + 1.7, 4, 11);
          const sp = fbm3(x * 120, 3.1, z * 120, 2, 23);
          const fine = noise3(x * 320, 7.7, z * 320, 31);
          const rimT = smoothstep(0.55, 0.98, r);
          const well = Math.exp(-(((r - 0.46) / 0.025) ** 2));
          const thr = 0.7 - 0.08 * rimT - 0.14 * (m - 0.5);
          const spot = smoothstep(thr, thr + 0.06, sp * 0.75 + fine * 0.25);
          const haze = smoothstep(0.45, 0.7, m) * rimT;
          const t = clamp((m - 0.35) * 1.2 + rimT * 0.25 - well * 0.15), t2 = t * t;
          setC(o, mix(0.03, 0.08, t2), mix(0.04, 0.11, t2), mix(0.12, 0.28, t2));
          blendC(o, 0.16, 0.22, 0.42, haze * 0.45);
          blendC(o, mix(0.28, 0.44, fine), mix(0.35, 0.52, fine), mix(0.56, 0.72, fine), spot * 0.6);
          o.metal = clamp(0.03 + 0.25 * haze + spot * 0.2, 0, 0.4);
          const peel = fbm3(x * 26, 5.3, z * 26, 3, 37);
          const pit = smoothstep(0.8, 0.9, noise3(x * 150, 9.1, z * 150, 39));
          o.c[0] *= 1 - 0.35 * pit; o.c[1] *= 1 - 0.35 * pit; o.c[2] *= 1 - 0.35 * pit;
          o.rough = clamp(0.58 + 0.14 * fine + 0.1 * peel - 0.12 * haze - spot * 0.08 + pit * 0.15, 0.2, 1);
          o.coat = 1 - 0.6 * pit;
          o.height = peel * 0.9 + sp * 0.5 + fine * 0.35 - spot * 0.2 - pit * 0.8;
        },
      };
    },
  },
  {
    name: 'Seiji Chawan', jp: '青磁茶碗',
    meta: 'Tea bowl · Ø 13 cm · celadon',
    desc: 'Pale jade celadon with tea-stained kannyū crackle. Broken clean through the well, with a shard lost from the rim and a hairline on the far side.',
    build() {
      const ctrl = [[0, 0.045], [0.22, 0.045], [0.26, 0.035], [0.28, 0], [0.36, 0], [0.375, 0.03], [0.39, 0.07], [0.46, 0.11],
        [0.6, 0.25], [0.71, 0.47], [0.77, 0.7], [0.79, 0.9], [0.795, 0.975], [0.787, 0.998], [0.772, 0.996], [0.762, 0.965],
        [0.753, 0.88], [0.73, 0.69], [0.665, 0.47], [0.55, 0.29], [0.4, 0.17], [0.22, 0.125], [0, 0.115]];
      const warp = (th, r, y) => [
        1 + (0.018 * Math.sin(2 * th + 0.3) + 0.01 * Math.sin(3 * th + 1.7) + 0.005 * Math.sin(5 * th + 2.1)) * smoothstep(0.2, 0.9, y),
        (0.02 * Math.sin(2 * th + 1) + 0.012 * Math.sin(3 * th)) * smoothstep(0.5, 1, y),
      ];
      const ripple = (r, y) => 0.0025 * Math.sin(y * 44) * smoothstep(0.15, 0.3, y) * (1 - smoothstep(0.85, 0.95, y));
      const surf = new Revolved(ctrl, { samples: 520, warp, ripple, lipBy: 'y' });
      const sO = (y) => surf.sAt('outer', 'y', y), sI = (y) => surf.sAt('inner', 'y', y), sL = surf.sLip;
      const O = (y, th) => [sO(y), th];
      // Split in two through the well; a shard knocked out of the rim; a hairline that stopped.
      const pA = planeThrough(surf, O(0.92, 1.2), O(0.25, 1.75));
      const A = fracture(surf, pA, { near: O(0.92, 1.2), seed: 11 });
      const pB = planeThrough(surf, O(0.92, 2.45), O(0.42, 1.62));
      const B = snapTo(surf, fracture(surf, pB, { keep: [sideOf(surf, pA, O(0.92, 2.45), 0.015)], near: O(0.92, 2.45), seed: 13 }), A);
      const C = fracture(surf, planeThrough(surf, O(0.95, 4.5), O(0.4, 4.72)), { keep: [above(0.42)], near: O(0.95, 4.5), seed: 17 });
      return {
        surf, cracks: [A, B, C],
        tex: { w: 2048, h: 1024, uv: 'cyl', normalStrength: 2.5 },
        coat: { clearcoat: 1, roughness: 0.05 }, normalScale: 0.35,
        gold: { width: 0.0088, height: 0.003, seed: 5 },
        scale: 1.45, motion: 'turn', view: { r: 4.6, phi: 1.12 },
        ao: (P) => (P.inner ? 0.45 + 0.55 * smoothstep(0.12, 0.9, P.y) : 0.75 + 0.25 * smoothstep(0, 0.3, P.y)),
        shade(P, o) {
          const { x, y, z, inner } = P;
          const m = fbm3(x * 3, y * 3, z * 3, 3, 5);
          const glazeLine = 0.15 + 0.1 * (fbm3(x * 7, y * 2, z * 7, 2, 9) - 0.5);
          if (!inner && y < glazeLine) {
            const g = noise3(x * 120, y * 120, z * 120, 3), iron = smoothstep(0.55, 0.75, fbm3(x * 14, y * 14, z * 14, 2, 4));
            const k = 0.9 + 0.2 * g;
            setC(o, mix(0.6, 0.46, iron) * k, mix(0.44, 0.29, iron) * k, mix(0.31, 0.19, iron) * k);
            o.rough = 0.85; o.coat = 0; o.height = g;
            return;
          }
          const edge = inner ? 0 : smoothstep(glazeLine + 0.05, glazeLine, y);
          const pool = inner ? 1 - smoothstep(0.12, 0.45, y) : 0;
          const lb = 1 - smoothstep(0, 0.035, cellEdge3(x * 9, y * 9, z * 9, 41));
          const lf = 1 - smoothstep(0, 0.035, cellEdge3(x * 24 + 3, y * 24, z * 24, 43));
          const t = clamp(pool * 0.8 + edge * 0.7 + (m - 0.5) * 0.7);
          setC(o, mix(0.67, 0.49, t), mix(0.77, 0.65, t), mix(0.69, 0.6, t));
          blendC(o, 0.5, 0.42, 0.28, lb * 0.55);
          blendC(o, o.c[0] * 0.85, o.c[1] * 0.85, o.c[2] * 0.85, lf * 0.4);
          o.rough = 0.07 + 0.05 * m; o.height = m * 0.3 - lb * 0.4 - lf * 0.15;
        },
      };
    },
  },
  {
    name: 'Shino Tsubo', jp: '志野壺',
    meta: 'Storage jar · H 24 cm · shino glaze',
    desc: 'Thick feldspathic glaze with pinholes and a fire-orange blush. A branching crack descends from the mouth to the shoulder.',
    build() {
      const ctrl = [[0, 0.035], [0.24, 0.035], [0.27, 0.025], [0.285, 0], [0.36, 0], [0.39, 0.03], [0.45, 0.12], [0.55, 0.36],
        [0.615, 0.66], [0.625, 0.86], [0.59, 1.12], [0.5, 1.36], [0.37, 1.55], [0.26, 1.68], [0.22, 1.77], [0.225, 1.86],
        [0.255, 1.94], [0.278, 1.985], [0.272, 2.003], [0.257, 2], [0.24, 1.965], [0.205, 1.88], [0.19, 1.78], [0.21, 1.68],
        [0.12, 1.62], [0, 1.6]];
      const warp = (th, r, y) => [
        1 + (0.014 * Math.sin(2 * th + 0.7) + 0.008 * Math.sin(3 * th + 2)) * smoothstep(0.1, 0.8, y),
        0.012 * Math.sin(2 * th + 0.2) * smoothstep(1.7, 2, y),
      ];
      const ripple = (r, y, s) => (s < 0.75 ? 0.0022 * Math.sin(y * 38) * smoothstep(0.2, 0.45, y) * (1 - smoothstep(1.3, 1.55, y)) : 0);
      const surf = new Revolved(ctrl, { samples: 640, warp, ripple, lipBy: 'y' });
      const sO = (y) => surf.sAt('outer', 'y', y), sI = (y) => surf.sAt('inner', 'y', y), sL = surf.sLip;
      const O = (y, th) => [sO(y), th];
      // A long crack from the mouth that runs out on the belly, a branch off it, and a short one behind.
      const pA = planeThrough(surf, O(1.97, 1.4), O(0.95, 1.72));
      const A = fracture(surf, pA, { keep: [above(0.78), facing(1.55)], near: O(1.97, 1.4), seed: 21 });
      const pB = planeThrough(surf, O(1.5, 1.55), O(0.95, 1.12));
      const B = snapTo(surf, fracture(surf, pB, { keep: [sideOf(surf, pA, O(0.95, 1.12), 0.015), above(0.82)], near: O(1.1, 1.2), seed: 23 }), A);
      const C = fracture(surf, planeThrough(surf, O(1.97, 4.4), O(1.4, 4.62)), { keep: [above(1.38), facing(4.5)], near: O(1.97, 4.4), seed: 27 });
      return {
        surf, cracks: [A, B, C],
        tex: { w: 2048, h: 1536, uv: 'cyl', normalStrength: 3 },
        coat: { clearcoat: 0.5, roughness: 0.2 }, normalScale: 0.55,
        gold: { width: 0.011, height: 0.0034, seed: 9 },
        motion: 'turn', view: { r: 6.4, phi: 1.4 },
        ao: (P) => (P.inner ? 0.15 + 0.6 * smoothstep(1.78, 1.98, P.y) : 1),
        shade(P, o) {
          const { x, y, z, inner } = P;
          const m = fbm3(x * 2.2, y * 2.2, z * 2.2, 4, 51);
          const f = fbm3(x * 12, y * 12, z * 12, 2, 53);
          if (!inner && y < 0.075 + 0.04 * f) {
            const g = noise3(x * 110, y * 110, z * 110, 3);
            setC(o, 0.74 * (0.9 + 0.2 * g), 0.55 * (0.9 + 0.2 * g), 0.4 * (0.9 + 0.2 * g));
            o.rough = 0.85; o.coat = 0; o.height = g;
            return;
          }
          const pin = noise3(x * 85, y * 85, z * 85, 57);
          const flash = smoothstep(0.55, 0.78, m + 0.1 * smoothstep(1.0, 1.7, y) - (inner ? 0.2 : 0));
          setC(o, mix(0.94, 0.85, f), mix(0.91, 0.8, f), mix(0.85, 0.71, f));
          blendC(o, 0.84, 0.56, 0.4, flash * 0.7);
          const ph = smoothstep(0.86, 0.93, pin);
          o.c[0] *= 1 - 0.45 * ph; o.c[1] *= 1 - 0.45 * ph; o.c[2] *= 1 - 0.45 * ph;
          o.rough = 0.42 - 0.12 * f + 0.1 * flash; o.coat = 0.7 - 0.4 * flash;
          o.height = f * 0.4 - ph * 1.2;
        },
      };
    },
  },
  {
    name: 'Aka Raku Guinomi', jp: '赤楽ぐい呑',
    meta: 'Sake cup · H 7 cm · red raku',
    desc: 'Smoke-blackened raku, crackled as it cooled in the open air. A lost shard returned to the lip and outlined in gold.',
    build() {
      const ctrl = [[0, 0.045], [0.28, 0.045], [0.31, 0.03], [0.33, 0], [0.42, 0], [0.45, 0.04], [0.5, 0.18], [0.535, 0.45],
        [0.55, 0.7], [0.553, 0.86], [0.548, 0.9], [0.535, 0.908], [0.52, 0.895], [0.512, 0.85], [0.508, 0.65], [0.49, 0.4],
        [0.45, 0.2], [0.36, 0.11], [0.2, 0.09], [0, 0.088]];
      const warp = (th, r, y) => [
        1 + (0.02 * Math.sin(2 * th + 1.3) + 0.012 * Math.sin(3 * th + 0.2)) * smoothstep(0.1, 0.9, y),
        0.015 * Math.sin(3 * th + 0.5) * smoothstep(0.6, 0.9, y),
      ];
      const surf = new Revolved(ctrl, { samples: 480, warp, lipBy: 'y' });
      const sO = (y) => surf.sAt('outer', 'y', y), sI = (y) => surf.sAt('inner', 'y', y), sL = surf.sLip;
      const O = (y, th) => [sO(y), th];
      // Yobitsugi shard: two fractures from the rim that meet in a V below it.
      const pA = planeThrough(surf, O(0.88, 1.12), O(0.3, 1.72));
      const pB = planeThrough(surf, O(0.88, 2.02), O(0.3, 1.42));
      const A = fracture(surf, pA, { keep: [sideOf(surf, pB, O(0.88, 1.12))], near: O(0.88, 1.12), seed: 31, amp: 0.6 });
      const B = fracture(surf, pB, { keep: [sideOf(surf, pA, O(0.88, 2.02))], near: O(0.88, 2.02), seed: 32, amp: 0.6 });
      A.join = B.join = [true, true];
      const C = fracture(surf, planeThrough(surf, O(0.88, 4.3), O(0.1, 4.55)), { keep: [above(0.06), facing(4.4, 0.04)], near: O(0.88, 4.3), seed: 33, amp: 0.6 });
      return {
        surf, cracks: [A, B, C],
        tex: { w: 2048, h: 1024, uv: 'cyl', normalStrength: 3 },
        coat: { clearcoat: 1, roughness: 0.08 }, normalScale: 0.3,
        gold: { width: 0.0088, height: 0.003, seed: 7 },
        scale: 1.7, motion: 'turn', view: { r: 4.6, phi: 1.15 },
        ao: (P) => (P.inner ? 0.4 + 0.6 * smoothstep(0.1, 0.85, P.y) : 0.85 + 0.15 * smoothstep(0, 0.2, P.y)),
        shade(P, o) {
          const { x, y, z, inner } = P;
          const m = fbm3(x * 4, y * 4, z * 4, 3, 61);
          if (!inner && y < 0.055) {
            const g = noise3(x * 120, y * 120, z * 120, 3);
            setC(o, 0.1 * (0.8 + 0.4 * g), 0.085 * (0.8 + 0.4 * g), 0.07 * (0.8 + 0.4 * g));
            o.rough = 0.9; o.coat = 0; o.height = g;
            return;
          }
          const smokeN = fbm3(x * 3 + 5, y * 3, z * 3, 3, 63);
          const line = 1 - smoothstep(0, 0.045, cellEdge3(x * 16, y * 16, z * 16, 67));
          const smoke = smoothstep(0.5, 0.72, smokeN + (inner ? 0 : 0.25 * (1 - smoothstep(0.05, 0.35, y))));
          const t = smoothstep(0.3, 0.7, m);
          setC(o, mix(0.64, 0.9, t), mix(0.17, 0.45, t), mix(0.08, 0.2, t));
          blendC(o, 0.045, 0.04, 0.035, Math.max(line * 0.92, smoke * 0.9));
          o.rough = 0.18 + 0.25 * smoke; o.coat = 1 - 0.5 * smoke;
          o.height = m * 0.3 - line * 0.6;
        },
      };
    },
  },
  {
    name: 'Ruri Hachi', jp: '瑠璃鉢',
    meta: 'Serving bowl · Ø 26 cm · cobalt glaze',
    desc: 'Lapis-blue glaze breaking to iron brown at the rim. Split clean across the well, with a wedge broken from the rim, and made whole again.',
    build() {
      const ctrl = [[0, 0.032], [0.28, 0.032], [0.31, 0.024], [0.325, 0], [0.42, 0], [0.44, 0.03], [0.5, 0.08], [0.65, 0.18],
        [0.82, 0.33], [0.94, 0.46], [0.99, 0.53], [1.005, 0.556], [0.998, 0.572], [0.982, 0.57], [0.965, 0.545], [0.92, 0.48],
        [0.8, 0.36], [0.62, 0.22], [0.45, 0.13], [0.25, 0.1], [0, 0.095]];
      const warp = (th, r) => [1 + (0.006 * Math.sin(2 * th + 0.5) + 0.004 * Math.sin(5 * th + 1)) * r * r, 0.01 * Math.sin(2 * th + 2) * r * r * r];
      const surf = new Revolved(ctrl, { samples: 520, warp, lipBy: 'r' });
      const I = (r, th) => [surf.sAt('inner', 'r', r), th];
      // Split across the well, plus a wedge-shaped shard between the split and the rim.
      const pA = planeThrough(surf, I(0.97, -0.9), I(0.97, 2.5));
      const A = fracture(surf, pA, { near: I(0.97, -0.9), seed: 41 });
      const pB = planeThrough(surf, I(0.97, 0.55), I(0.3, -0.35));
      const B = snapTo(surf, fracture(surf, pB, { keep: [sideOf(surf, pA, I(0.97, 0.55), 0.015)], near: I(0.97, 0.55), seed: 43 }), A);
      return {
        surf, cracks: [A, B],
        tex: { w: 2048, h: 1024, uv: 'cyl', normalStrength: 2 },
        coat: { clearcoat: 1, roughness: 0.04 }, normalScale: 0.3,
        gold: { width: 0.0098, height: 0.003, seed: 11 },
        motion: 'turn', view: { r: 5.0, phi: 0.98 },
        ao: (P) => (P.inner ? 0.62 + 0.38 * smoothstep(0.08, 0.5, P.y) : 0.85 + 0.15 * smoothstep(0, 0.2, P.y)),
        shade(P, o) {
          const { x, y, z, r, th, inner } = P;
          const m = fbm3(x * 3, y * 3, z * 3, 3, 71);
          if (!inner && y < 0.045) {
            const g = noise3(x * 120, y * 120, z * 120, 3);
            setC(o, 0.78 * (0.92 + 0.16 * g), 0.71 * (0.92 + 0.16 * g), 0.6 * (0.92 + 0.16 * g));
            o.rough = 0.8; o.coat = 0; o.height = g;
            return;
          }
          const st = fbm3(Math.cos(th) * 7, r * 4, Math.sin(th) * 7, 3, 73);
          const t = smoothstep(0.35, 0.75, mix(m, st * 0.55 + m * 0.45, smoothstep(0.12, 0.5, r)));
          setC(o, mix(0.05, 0.2, t), mix(0.09, 0.36, t), mix(0.3, 0.7, t));
          if (inner && r < 0.42) { const p = 1 - smoothstep(0.2, 0.42, r); o.c[0] *= 1 - 0.3 * p; o.c[1] *= 1 - 0.3 * p; o.c[2] *= 1 - 0.2 * p; }
          blendC(o, 0.52, 0.38, 0.24, smoothstep(0.47, 0.56, y) * 0.75);
          o.rough = 0.05 + 0.04 * m; o.height = m * 0.2 + st * 0.2;
        },
      };
    },
  },
];
// ==== CORE END =============================================================

export {
  TAU, D2R, clamp, mix, smoothstep, nextFrame, noise3, fbm3,
  Revolved, chordCrack, planeThrough, fracture, buildBead, bakeMaps, bakeGold, PIECES, trace,
};
