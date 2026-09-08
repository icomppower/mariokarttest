// Minimal .glb reader: enough to pull named meshes and empties out of a
// Blender export so the sim can run without Three.js (Node tests, workers).
// Handles: GLB container, accessors (float/ushort/uint/ubyte), node
// hierarchies with TRS or matrix, multiple primitives per mesh, extras.

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT = {
  5120: [Int8Array, 1],
  5121: [Uint8Array, 1],
  5122: [Int16Array, 2],
  5123: [Uint16Array, 2],
  5125: [Uint32Array, 4],
  5126: [Float32Array, 4],
};
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function parseGlb(buffer) {
  const ab = toArrayBuffer(buffer);
  const dv = new DataView(ab);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a GLB file (bad magic)');
  const total = dv.getUint32(8, true);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, start, len)));
    } else if (type === CHUNK_BIN) {
      bin = ab.slice(start, start + len);
    }
    off = start + len;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

function toArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) return buf;
  if (ArrayBuffer.isView(buf)) return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  throw new Error('parseGlb expects an ArrayBuffer or typed array');
}

export function readAccessor(gltf, index) {
  const { json, bin } = gltf;
  const acc = json.accessors[index];
  const [Ctor, csize] = COMPONENT[acc.componentType];
  const ncomp = TYPE_SIZE[acc.type];
  const out = new Ctor(acc.count * ncomp);
  if (acc.bufferView === undefined) return { data: out, count: acc.count, ncomp };
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || csize * ncomp;
  const dv = new DataView(bin);
  const getter = {
    5120: dv.getInt8,
    5121: dv.getUint8,
    5122: dv.getInt16,
    5123: dv.getUint16,
    5125: dv.getUint32,
    5126: dv.getFloat32,
  }[acc.componentType].bind(dv);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < ncomp; c++) {
      out[i * ncomp + c] = csize === 1 ? getter(base + i * stride + c) : getter(base + i * stride + c * csize, true);
    }
  }
  return { data: out, count: acc.count, ncomp };
}

// --- tiny mat4 (column-major, like glTF) ---
function mat4Identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function mat4Mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
function mat4FromTRS(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
function transformDir(m, x, y, z) {
  const v = [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function nodeLocal(node) {
  if (node.matrix) return node.matrix.slice();
  return mat4FromTRS(node.translation, node.rotation, node.scale);
}

/** Walk the default scene and return every node with its world matrix. */
export function walkNodes(gltf) {
  const { json } = gltf;
  const scene = json.scenes[json.scene || 0];
  const out = [];
  const visit = (ni, parent) => {
    const node = json.nodes[ni];
    const world = mat4Mul(parent, nodeLocal(node));
    out.push({ index: ni, node, world });
    for (const c of node.children || []) visit(c, world);
  };
  for (const r of scene.nodes || []) visit(r, mat4Identity());
  return out;
}

/**
 * Extract named objects. Meshes come back with world-space positions and a
 * concatenated index buffer across primitives; empties come back with a
 * position and a forward vector (the node's local +Z, which is Blender −Y).
 */
export function extractObjects(gltf) {
  const { json } = gltf;
  const meshes = [];
  const empties = [];
  for (const { node, world } of walkNodes(gltf)) {
    const name = node.name || '';
    const extras = node.extras || {};
    if (node.mesh === undefined) {
      const p = transformPoint(world, 0, 0, 0);
      const f = transformDir(world, 0, 0, 1);
      empties.push({ name, x: p[0], y: p[1], z: p[2], forward: f, extras, node });
      continue;
    }
    const mesh = json.meshes[node.mesh];
    const posParts = [];
    const idxParts = [];
    let vcount = 0;
    for (const prim of mesh.primitives) {
      if (prim.mode !== undefined && prim.mode !== 4 && prim.mode !== 1) continue;
      const pos = readAccessor(gltf, prim.attributes.POSITION);
      const wp = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const q = transformPoint(world, pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]);
        wp[i * 3] = q[0];
        wp[i * 3 + 1] = q[1];
        wp[i * 3 + 2] = q[2];
      }
      let idx;
      if (prim.indices !== undefined) {
        idx = readAccessor(gltf, prim.indices).data;
      } else {
        idx = new Uint32Array(pos.count);
        for (let i = 0; i < pos.count; i++) idx[i] = i;
      }
      const shifted = new Uint32Array(idx.length);
      for (let i = 0; i < idx.length; i++) shifted[i] = idx[i] + vcount;
      posParts.push(wp);
      idxParts.push({ data: shifted, mode: prim.mode === undefined ? 4 : prim.mode });
      vcount += pos.count;
    }
    const positions = concat(Float32Array, posParts);
    const tris = concat(Uint32Array, idxParts.filter((p) => p.mode === 4).map((p) => p.data));
    const lines = concat(Uint32Array, idxParts.filter((p) => p.mode === 1).map((p) => p.data));
    meshes.push({ name, positions, indices: tris, lineIndices: lines, extras: { ...(mesh.extras || {}), ...extras }, node });
  }
  return { meshes, empties, sceneExtras: (json.scenes[json.scene || 0].extras) || {} };
}

function concat(Ctor, parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Ctor(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
