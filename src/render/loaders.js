// GLTF loading for the render layer. The same .glb bytes feed the sim's own
// parser (src/sim/gltf.js) so the physics and the picture come from one file.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { parseGlb } from '../sim/gltf.js';
import { Track, NAMES } from '../sim/track.js';

const KART_LENGTH = 2.4;
const loader = new GLTFLoader();

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

function parseGltf(buffer, url) {
  return new Promise((resolve, reject) => loader.parse(buffer, '', resolve, (e) => reject(new Error(`GLTFLoader could not parse ${url}: ${e && e.message ? e.message : e}`))));
}

/** Load the track: sim Track + Three.js scene graph, from one .glb. */
export async function loadTrack(url, { materials = 'standard' } = {}) {
  const buffer = await fetchBytes(url);
  let track;
  try {
    track = Track.fromGltf(parseGlb(buffer.slice(0)));
  } catch (e) {
    throw new Error(`${url}: ${e.message}`);
  }
  const gltf = await parseGltf(buffer, url);
  const root = gltf.scene;
  const toRemove = [];
  root.traverse((o) => {
    if (o.isLine || o.isLineSegments) {
      toRemove.push(o); // TRACK_CENTERLINE, TRACK_CURVE: data, not picture
      return;
    }
    if (o.isMesh) {
      if (o.name.startsWith(NAMES.WALL_PREFIX)) {
        o.visible = false; // collision only
        return;
      }
      o.castShadow = !o.name.startsWith('ISLAND');
      o.receiveShadow = true;
      if (o.name === 'START_LINE' || o.name.startsWith('MARK_PAD')) {
        o.material.polygonOffset = true;
        o.material.polygonOffsetFactor = -2;
        o.castShadow = false;
      }
    }
  });
  for (const o of toRemove) o.parent.remove(o);
  const merged = mergeStaticScenery(root);
  if (materials === 'lambert') simplifyMaterials(root);
  return { track, root, merged };
}

const KEEP_SEPARATE = /^(TRACK_|WALL_|START_LINE$|MARK_PAD|ISLAND)/;

/**
 * Scenery instances share a handful of materials; collapse them into one
 * mesh per material so ~150 draw calls become ~15. Gameplay objects and the
 * big island stay separate (frustum culling still helps them).
 */
function mergeStaticScenery(root) {
  root.updateMatrixWorld(true);
  const groups = new Map();
  const victims = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.visible || KEEP_SEPARATE.test(o.name)) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k);
    const key = o.material.uuid;
    if (!groups.has(key)) groups.set(key, { material: o.material, geoms: [] });
    groups.get(key).geoms.push(g);
    victims.push(o);
  });
  for (const v of victims) v.parent.remove(v);
  let count = 0;
  for (const { material, geoms } of groups.values()) {
    const geom = mergeGeometries(geoms, false);
    if (!geom) continue;
    const m = new THREE.Mesh(geom, material);
    m.name = `MERGED_${material.name}`;
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
    count++;
  }
  return { instances: victims.length, meshes: count };
}

/** Test fixture: swap PBR materials for Lambert to lighten the software rasterizer. */
function simplifyMaterials(root) {
  const cache = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    if (!cache.has(src.uuid)) {
      const m = new THREE.MeshLambertMaterial({ color: src.color, emissive: src.emissive, emissiveIntensity: src.emissiveIntensity, side: src.side, polygonOffset: src.polygonOffset, polygonOffsetFactor: src.polygonOffsetFactor });
      m.name = src.name;
      cache.set(src.uuid, m);
    }
    o.material = cache.get(src.uuid);
  });
}

/** Load a kart: recenter in XZ, ground to y=0, scale longest horizontal dimension to 2.4 m. */
export async function loadKart(url) {
  const buffer = await fetchBytes(url);
  const gltf = await parseGltf(buffer, url);
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.z);
  if (!(longest > 0)) throw new Error(`${url}: kart has no geometry`);
  const scale = KART_LENGTH / longest;
  const center = box.getCenter(new THREE.Vector3());
  const inner = new THREE.Group();
  inner.add(model);
  model.position.set(-center.x, -box.min.y, -center.z);
  inner.scale.setScalar(scale);
  const wheels = {};
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = false;
    }
    const m = /^WHEEL_(FL|FR|RL|RR)$/.exec(o.name);
    if (m) wheels[m[1]] = o;
  });
  const group = new THREE.Group();
  group.add(inner);
  return { group, wheels, length: size.z * scale, width: size.x * scale };
}
