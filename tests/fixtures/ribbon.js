// Test-only track fixture: a closed parametric loop swept into a ribbon.
// This exists so the sim can be unit-tested before/without the Blender
// export. It is never used by the game; gameplay geometry comes from
// assets/track.glb (see SPEC.md).

import { Track } from '../../src/sim/track.js';

export function ribbonTrack({ samples = 360, halfWidth = 6.5, walls = true, pads = true } = {}) {
  const pts = [];
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    const x = 110 * Math.cos(t) + 25 * Math.cos(3 * t);
    const z = 75 * Math.sin(t) - 20 * Math.sin(2 * t);
    const y = 2.5 * Math.sin(2 * t) + 1.5 * Math.cos(5 * t);
    pts.push([x, y, z]);
  }
  const surface = ribbonMesh(pts, halfWidth);
  const def = { centerline: pts, surface, walls: [], pads: [] };
  if (walls) {
    // Two short kerb walls on the outside of the first bend.
    def.walls.push(boxWall(pts, 60, 12, halfWidth + 1.5, 6));
    def.walls.push(boxWall(pts, 200, 12, -(halfWidth + 1.5), 6));
  }
  if (pads) {
    for (const i of [90, 270]) def.pads.push({ name: `PAD_${i}`, x: pts[i][0], y: pts[i][1], z: pts[i][2], radius: 3 });
  }
  return new Track(def);
}

/** Sweep the polyline into a two-triangle-per-segment ribbon. */
export function ribbonMesh(pts, hw) {
  const n = pts.length;
  const positions = new Float32Array(n * 2 * 3);
  const indices = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    let tx = b[0] - a[0], tz = b[2] - a[2];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    const nx = tz, nz = -tx;
    positions.set([a[0] + nx * hw, a[1], a[2] + nz * hw], i * 6);
    positions.set([a[0] - nx * hw, a[1], a[2] - nz * hw], i * 6 + 3);
    const l0 = i * 2, r0 = i * 2 + 1;
    const l1 = ((i + 1) % n) * 2, r1 = ((i + 1) % n) * 2 + 1;
    indices.set([l0, r0, l1, r0, r1, l1], i * 6);
  }
  return { positions, indices };
}

/** Axis-agnostic box wall placed at sample index `i`, offset laterally. */
function boxWall(pts, i, length, lateral, height) {
  const a = pts[i];
  const b = pts[(i + 1) % pts.length];
  let tx = b[0] - a[0], tz = b[2] - a[2];
  const l = Math.hypot(tx, tz) || 1;
  tx /= l;
  tz /= l;
  const nx = tz, nz = -tx;
  const cx = a[0] + nx * lateral, cz = a[2] + nz * lateral;
  const hl = length / 2, ht = 0.6;
  const corners = [
    [cx - tx * hl + nx * ht, cz - tz * hl + nz * ht],
    [cx + tx * hl + nx * ht, cz + tz * hl + nz * ht],
    [cx + tx * hl - nx * ht, cz + tz * hl - nz * ht],
    [cx - tx * hl - nx * ht, cz - tz * hl - nz * ht],
  ];
  const positions = new Float32Array(8 * 3);
  corners.forEach(([x, z], k) => {
    positions.set([x, a[1], z], k * 3);
    positions.set([x, a[1] + height, z], (k + 4) * 3);
  });
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, // bottom
    4, 6, 5, 4, 7, 6, // top
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ]);
  return { positions, indices };
}
