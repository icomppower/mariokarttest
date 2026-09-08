// Pure geometry helpers shared by the sim. No DOM, no Three.js.

export const TAU = Math.PI * 2;

export function wrapAngle(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Uniform grid over the XZ plane that buckets triangle indices by bounding
 * box. Used for the "raycast down" on-track test and for wall edges.
 */
export class XZGrid {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
    this.minX = Infinity;
    this.minZ = Infinity;
    this.maxX = -Infinity;
    this.maxZ = -Infinity;
  }
  key(ix, iz) {
    return ix * 73856093 + iz * 19349663;
  }
  insertBox(x0, z0, x1, z1, item) {
    this.minX = Math.min(this.minX, x0);
    this.minZ = Math.min(this.minZ, z0);
    this.maxX = Math.max(this.maxX, x1);
    this.maxZ = Math.max(this.maxZ, z1);
    const ix0 = Math.floor(x0 / this.cell);
    const iz0 = Math.floor(z0 / this.cell);
    const ix1 = Math.floor(x1 / this.cell);
    const iz1 = Math.floor(z1 / this.cell);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = this.key(ix, iz);
        let b = this.map.get(k);
        if (!b) {
          b = [];
          this.map.set(k, b);
        }
        b.push(item);
      }
    }
  }
  query(x, z) {
    return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell))) || EMPTY;
  }
  queryBox(x0, z0, x1, z1, out = []) {
    const ix0 = Math.floor(x0 / this.cell);
    const iz0 = Math.floor(z0 / this.cell);
    const ix1 = Math.floor(x1 / this.cell);
    const iz1 = Math.floor(z1 / this.cell);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const b = this.map.get(this.key(ix, iz));
        if (b) for (let i = 0; i < b.length; i++) out.push(b[i]);
      }
    }
    return out;
  }
}
const EMPTY = Object.freeze([]);

/**
 * Triangle soup with a vertical raycast. `positions` is a flat Float32Array
 * (x,y,z per vertex) and `indices` a flat index array (3 per triangle).
 */
export class TriMesh {
  constructor(positions, indices, cell = 4) {
    this.p = positions;
    this.i = indices;
    this.triCount = indices.length / 3;
    this.grid = new XZGrid(cell);
    for (let t = 0; t < this.triCount; t++) {
      const a = indices[t * 3] * 3;
      const b = indices[t * 3 + 1] * 3;
      const c = indices[t * 3 + 2] * 3;
      const x0 = Math.min(positions[a], positions[b], positions[c]);
      const x1 = Math.max(positions[a], positions[b], positions[c]);
      const z0 = Math.min(positions[a + 2], positions[b + 2], positions[c + 2]);
      const z1 = Math.max(positions[a + 2], positions[b + 2], positions[c + 2]);
      this.grid.insertBox(x0, z0, x1, z1, t);
    }
  }

  /**
   * Cast a ray straight down from (x, yFrom, z). Returns the y of the highest
   * triangle surface below yFrom, or null when nothing is hit.
   */
  raycastDown(x, z, yFrom = 1e9) {
    const cands = this.grid.query(x, z);
    let best = null;
    const p = this.p;
    const idx = this.i;
    for (let k = 0; k < cands.length; k++) {
      const t = cands[k];
      const a = idx[t * 3] * 3;
      const b = idx[t * 3 + 1] * 3;
      const c = idx[t * 3 + 2] * 3;
      const ax = p[a], az = p[a + 2];
      const bx = p[b], bz = p[b + 2];
      const cx = p[c], cz = p[c + 2];
      // Barycentric coordinates in the XZ projection.
      const v0x = bx - ax, v0z = bz - az;
      const v1x = cx - ax, v1z = cz - az;
      const v2x = x - ax, v2z = z - az;
      const den = v0x * v1z - v1x * v0z;
      if (Math.abs(den) < 1e-12) continue; // degenerate / vertical triangle
      const v = (v2x * v1z - v1x * v2z) / den;
      const w = (v0x * v2z - v2x * v0z) / den;
      const u = 1 - v - w;
      const eps = -1e-6;
      if (u < eps || v < eps || w < eps) continue;
      const y = u * p[a + 1] + v * p[b + 1] + w * p[c + 1];
      if (y <= yFrom && (best === null || y > best)) best = y;
    }
    return best;
  }

  /** Random point on the surface, for tests. */
  randomPoint(rng) {
    const t = rng.int(this.triCount);
    const a = this.i[t * 3] * 3;
    const b = this.i[t * 3 + 1] * 3;
    const c = this.i[t * 3 + 2] * 3;
    let r1 = rng.next();
    let r2 = rng.next();
    if (r1 + r2 > 1) {
      r1 = 1 - r1;
      r2 = 1 - r2;
    }
    const r0 = 1 - r1 - r2;
    const p = this.p;
    return {
      x: r0 * p[a] + r1 * p[b] + r2 * p[c],
      y: r0 * p[a + 1] + r1 * p[b + 1] + r2 * p[c + 1],
      z: r0 * p[a + 2] + r1 * p[b + 2] + r2 * p[c + 2],
    };
  }
}

/**
 * 2D edge set (XZ) for wall collision. Edges are deduplicated so a box wall
 * contributes its footprint once.
 */
export class EdgeSet {
  constructor(cell = 8) {
    this.edges = []; // [x0,z0,x1,z1] flat
    this.grid = new XZGrid(cell);
    this.seen = new Set();
  }
  addMesh(positions, indices) {
    const q = (v) => Math.round(v * 100) / 100;
    for (let t = 0; t < indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const i0 = indices[t + e] * 3;
        const i1 = indices[t + ((e + 1) % 3)] * 3;
        let x0 = q(positions[i0]), z0 = q(positions[i0 + 2]);
        let x1 = q(positions[i1]), z1 = q(positions[i1 + 2]);
        if (Math.abs(x0 - x1) < 1e-6 && Math.abs(z0 - z1) < 1e-6) continue; // vertical edge
        if (x0 > x1 || (x0 === x1 && z0 > z1)) {
          [x0, x1] = [x1, x0];
          [z0, z1] = [z1, z0];
        }
        const key = `${x0},${z0},${x1},${z1}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        const id = this.edges.length;
        this.edges.push([x0, z0, x1, z1]);
        this.grid.insertBox(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), id);
      }
    }
  }
  get size() {
    return this.edges.length;
  }
}

/** Closest point on segment AB to P, in 2D. Returns {x, z, t, d2}. */
export function closestOnSegment2D(ax, az, bx, bz, px, pz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = clamp(t, 0, 1);
  const x = ax + dx * t, z = az + dz * t;
  const ex = px - x, ez = pz - z;
  return { x, z, t, d2: ex * ex + ez * ez };
}

/** Segment-segment intersection parameter along P0P1, or null. */
export function segmentIntersect2D(p0x, p0z, p1x, p1z, q0x, q0z, q1x, q1z) {
  const rx = p1x - p0x, rz = p1z - p0z;
  const sx = q1x - q0x, sz = q1z - q0z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qpx = q0x - p0x, qpz = q0z - p0z;
  const t = (qpx * sz - qpz * sx) / den;
  const u = (qpx * rz - qpz * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}
