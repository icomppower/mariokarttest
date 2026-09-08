// Track model: a closed centerline spline plus a drivable surface mesh.
// Built from the Blender export (see SPEC.md "Blender contract") or from a
// test fixture. No rendering code here.

import { TriMesh, EdgeSet, clamp } from './geom.js';
import { extractObjects } from './gltf.js';

export const NAMES = {
  SURFACE: 'TRACK_SURFACE',
  CENTERLINE: 'TRACK_CENTERLINE',
  START: 'TRACK_START',
  PAD_PREFIX: 'PAD_',
  WALL_PREFIX: 'WALL_',
};

export class Track {
  /**
   * @param {object} def
   * @param {number[][]} def.centerline ordered [x,y,z] points, closed loop, first = start line
   * @param {{positions:Float32Array, indices:Uint32Array}} def.surface drivable mesh
   * @param {Array<{positions:Float32Array, indices:Uint32Array}>} [def.walls]
   * @param {Array<{name:string,x:number,y:number,z:number,radius?:number}>} [def.pads]
   * @param {{x:number,y:number,z:number,heading:number}} [def.start]
   * @param {object} [def.extras]
   */
  constructor(def) {
    const pts = def.centerline;
    if (!pts || pts.length < 3) throw new Error('Track needs a centerline with at least 3 points');
    this.points = pts;
    this.n = pts.length;
    // Cumulative arc length; segment i goes from point i to point (i+1) % n.
    this.cum = new Float64Array(this.n + 1);
    for (let i = 0; i < this.n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % this.n];
      this.cum[i + 1] = this.cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    this.length = this.cum[this.n];
    this.surface = new TriMesh(def.surface.positions, def.surface.indices, 4);
    this.walls = new EdgeSet(8);
    for (const w of def.walls || []) this.walls.addMesh(w.positions, w.indices);
    this.pads = (def.pads || []).map((p) => ({ radius: 2.5, ...p }));
    this.extras = def.extras || {};
    const s0 = this.sample(0);
    this.start = def.start || { x: s0.x, y: s0.y, z: s0.z, heading: Math.atan2(s0.tx, s0.tz) };
    this._widthCache = new Map();
  }

  /** Point, tangent, and left normal at arc length s (wraps). */
  sample(s) {
    const L = this.length;
    s = ((s % L) + L) % L;
    // binary search segment
    let lo = 0, hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const a = this.points[i];
    const b = this.points[(i + 1) % this.n];
    const segLen = this.cum[i + 1] - this.cum[i];
    const t = segLen > 0 ? (s - this.cum[i]) / segLen : 0;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    const z = a[2] + (b[2] - a[2]) * t;
    let tx = b[0] - a[0], tz = b[2] - a[2];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    // Left normal in XZ: rotate tangent +90° about Y (forward=(sinθ,cosθ) → left=(cosθ,−sinθ)).
    return { x, y, z, tx, tz, nx: tz, nz: -tx, s, segment: i };
  }

  /**
   * Closest point on the centerline to (x,y,z). Returns arc length s, the
   * signed lateral offset (positive = left of travel) and the 3D distance.
   */
  project(x, y, z) {
    let bestD2 = Infinity, bestI = 0, bestT = 0;
    for (let i = 0; i < this.n; i++) {
      const a = this.points[i];
      const b = this.points[(i + 1) % this.n];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const len2 = dx * dx + dy * dy + dz * dz;
      let t = len2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / len2 : 0;
      t = clamp(t, 0, 1);
      const px = a[0] + dx * t - x, py = a[1] + dy * t - y, pz = a[2] + dz * t - z;
      const d2 = px * px + py * py + pz * pz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestI = i;
        bestT = t;
      }
    }
    const s = this.cum[bestI] + (this.cum[bestI + 1] - this.cum[bestI]) * bestT;
    const sm = this.sample(s);
    const lateral = (x - sm.x) * sm.nx + (z - sm.z) * sm.nz;
    return { s, lateral, dist: Math.sqrt(bestD2), segment: bestI };
  }

  /** Height of the drivable surface under (x,z), or null when off-track. */
  groundY(x, z, yFrom = 1e9) {
    return this.surface.raycastDown(x, z, yFrom);
  }

  onTrack(x, z, yFrom = 1e9) {
    return this.surface.raycastDown(x, z, yFrom) !== null;
  }

  /**
   * Drivable half-widths at arc length s, measured by marching raycasts
   * outward from the centerline until the surface is missed.
   */
  widthAt(s, step = 0.25, max = 40) {
    const key = Math.round(s / 2) * 2; // cache at 2 m resolution
    const hit = this._widthCache.get(key);
    if (hit) return hit;
    const c = this.sample(key);
    const yFrom = c.y + 4;
    const march = (sign) => {
      let d = 0;
      while (d < max) {
        const nd = d + step;
        if (this.surface.raycastDown(c.x + c.nx * nd * sign, c.z + c.nz * nd * sign, yFrom) === null) break;
        d = nd;
      }
      return d;
    };
    const w = { left: march(1), right: march(-1) };
    this._widthCache.set(key, w);
    return w;
  }

  /** Signed curvature estimate (rad per metre) around s, for AI throttle. */
  curvatureAt(s, span = 6) {
    const a = this.sample(s - span);
    const b = this.sample(s + span);
    const ha = Math.atan2(a.tx, a.tz);
    const hb = Math.atan2(b.tx, b.tz);
    let d = hb - ha;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d / (2 * span);
  }

  /** Build from a parsed GLB (see gltf.js). Throws named errors on contract violations. */
  static fromGltf(gltf) {
    const { meshes, empties } = extractObjects(gltf);
    const mesh = (name) => meshes.find((m) => m.name === name);
    const surface = mesh(NAMES.SURFACE);
    if (!surface || surface.indices.length === 0) throw new Error(`track.glb: missing mesh object ${NAMES.SURFACE}`);
    const cl = mesh(NAMES.CENTERLINE);
    if (!cl) throw new Error(`track.glb: missing object ${NAMES.CENTERLINE}`);
    if (cl.indices.length > 0) throw new Error(`track.glb: ${NAMES.CENTERLINE} must be edges only (it has faces)`);
    const start = empties.find((e) => e.name === NAMES.START);
    if (!start) throw new Error(`track.glb: missing empty ${NAMES.START}`);
    const centerline = orderCenterline(cl, start);
    const walls = meshes.filter((m) => m.name.startsWith(NAMES.WALL_PREFIX));
    const pads = empties
      .filter((e) => e.name.startsWith(NAMES.PAD_PREFIX))
      .map((e) => ({ name: e.name, x: e.x, y: e.y, z: e.z, radius: e.extras.radius || 2.5 }));
    const heading = Math.atan2(start.forward[0], start.forward[2]);
    return new Track({
      centerline,
      surface: { positions: surface.positions, indices: surface.indices },
      walls,
      pads,
      start: { x: start.x, y: start.y, z: start.z, heading },
      extras: { ...cl.extras, ...start.extras },
    });
  }
}

/**
 * Order the centerline vertices by walking its edge loop, starting at the
 * vertex nearest TRACK_START and heading in the direction of its forward
 * vector. This makes the sim independent of the exporter's vertex order.
 */
function orderCenterline(cl, start) {
  const p = cl.positions;
  const nv = p.length / 3;
  if (nv < 3) throw new Error('track.glb: TRACK_CENTERLINE needs at least 3 vertices');
  const adj = Array.from({ length: nv }, () => []);
  const li = cl.lineIndices;
  for (let i = 0; i + 1 < li.length; i += 2) {
    adj[li[i]].push(li[i + 1]);
    adj[li[i + 1]].push(li[i]);
  }
  const pt = (i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  if (li.length === 0) {
    // No edge data: trust vertex order as exported.
    return Array.from({ length: nv }, (_, i) => pt(i));
  }
  let first = 0, bd = Infinity;
  for (let i = 0; i < nv; i++) {
    const d = (p[i * 3] - start.x) ** 2 + (p[i * 3 + 1] - start.y) ** 2 + (p[i * 3 + 2] - start.z) ** 2;
    if (d < bd) {
      bd = d;
      first = i;
    }
  }
  if (adj[first].length !== 2) throw new Error(`track.glb: TRACK_CENTERLINE is not a closed loop at vertex ${first}`);
  // Choose the neighbour that agrees with the start heading.
  const f = start.forward;
  const score = (j) => (p[j * 3] - p[first * 3]) * f[0] + (p[j * 3 + 2] - p[first * 3 + 2]) * f[2];
  const [n0, n1] = adj[first];
  let prev = first;
  let cur = score(n0) >= score(n1) ? n0 : n1;
  const order = [pt(first)];
  const seen = new Set([first]);
  while (cur !== first) {
    if (seen.has(cur)) throw new Error('track.glb: TRACK_CENTERLINE loop revisits a vertex (self-intersection?)');
    seen.add(cur);
    order.push(pt(cur));
    const nb = adj[cur];
    if (nb.length !== 2) throw new Error(`track.glb: TRACK_CENTERLINE is not a closed loop at vertex ${cur}`);
    const next = nb[0] === prev ? nb[1] : nb[0];
    prev = cur;
    cur = next;
  }
  if (order.length !== nv) throw new Error(`track.glb: TRACK_CENTERLINE has ${nv - order.length} vertices off the loop`);
  return order;
}
