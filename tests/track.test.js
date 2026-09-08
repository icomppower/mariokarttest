// G1 gate: the Blender export drives the sim. Runs against the committed assets/track.glb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseGlb } from '../src/sim/gltf.js';
import { Track } from '../src/sim/track.js';
import { Race } from '../src/sim/race.js';
import { makeRng } from '../src/sim/rng.js';

const GLB = new URL('../assets/track.glb', import.meta.url);
const loadTrack = () => Track.fromGltf(parseGlb(readFileSync(GLB)));

test('G1: sampled centerline length is within 2% of Blender curve_length', () => {
  const track = loadTrack();
  const curveLen = track.extras.curve_length;
  assert.ok(typeof curveLen === 'number' && curveLen > 0, 'curve_length extras missing');
  const err = Math.abs(track.length - curveLen) / curveLen;
  console.log(`  centerline ${track.n} verts, polyline ${track.length.toFixed(2)} m vs curve ${curveLen.toFixed(2)} m (${(err * 100).toFixed(3)}%)`);
  assert.ok(err < 0.02, `length error ${(err * 100).toFixed(2)}% exceeds 2%`);
  assert.equal(track.pads.length, 3);
  assert.ok(track.walls.size > 0, 'expected WALL_* edges');
});

test('G1: 100 random surface points are on-track, 100 offset points are off-track', () => {
  const track = loadTrack();
  const rng = makeRng('g1-points');
  let on = 0;
  for (let i = 0; i < 100; i++) {
    const p = track.surface.randomPoint(rng);
    if (track.onTrack(p.x, p.z, p.y + 3)) on++;
  }
  assert.equal(on, 100, `${100 - on} surface points classified off-track`);
  let off = 0;
  for (let i = 0; i < 100; i++) {
    const s = rng.range(0, track.length);
    const c = track.sample(s);
    const w = track.widthAt(s);
    const side = rng.next() < 0.5 ? 1 : -1;
    const half = side > 0 ? w.left : w.right;
    const d = half + 3 + rng.range(0, 7);
    if (!track.onTrack(c.x + c.nx * d * side, c.z + c.nz * d * side, c.y + 3)) off++;
  }
  assert.equal(off, 100, `${100 - off} offset points classified on-track`);
});

test('G1: measured widths match the authored road (asphalt + 1 m curbs, 5.2..9.2 m half-width)', () => {
  const track = loadTrack();
  for (let s = 0; s < track.length; s += 37) {
    const w = track.widthAt(s);
    assert.ok(w.left > 5.5 && w.left < 11.5, `left half-width ${w.left} at s=${s}`);
    assert.ok(w.right > 5.5 && w.right < 11.5, `right half-width ${w.right} at s=${s}`);
  }
});

test('G1: start empty sits on the surface and faces along the centerline', () => {
  const track = loadTrack();
  const c = track.sample(0);
  const st = track.start;
  assert.ok(Math.hypot(st.x - c.x, st.z - c.z) < 1.5, 'TRACK_START is not at the first centerline vertex');
  const dot = Math.sin(st.heading) * c.tx + Math.cos(st.heading) * c.tz;
  assert.ok(dot > 0.98, `start heading misaligned with centerline tangent (dot=${dot.toFixed(3)})`);
  assert.ok(track.onTrack(st.x, st.z, st.y + 3));
});

test('G1: AI completes a 3-lap race on the Blender track, deterministically', () => {
  const run = (seed) => {
    const race = new Race({ track: loadTrack(), seed, kartCount: 4, laps: 3, log: true });
    const ticks = race.runToFinish(60 * 60 * 10);
    return { race, ticks, hash: createHash('sha256').update(race.log.join('\n')).digest('hex') };
  };
  const a = run('dusk');
  assert.equal(a.race.phase, 'finished', `race did not finish in ${a.ticks} ticks`);
  const b = run('dusk');
  assert.equal(a.hash, b.hash);
  const laps = a.race.standings.map((k) => `${k.name}:${k.lapTimes.map((t) => t.toFixed(1)).join('/')}`);
  console.log(`  finished in ${(a.ticks / 60).toFixed(1)} s; ${laps.join('  ')}`);
});

test('G1 negative: a renamed TRACK_CENTERLINE fails with a named error', () => {
  const gltf = parseGlb(readFileSync(GLB));
  const node = gltf.json.nodes.find((n) => n.name === 'TRACK_CENTERLINE');
  node.name = 'TRACK_CENTRELINE';
  assert.throws(() => Track.fromGltf(gltf), /missing object TRACK_CENTERLINE/);
});

test('G1 negative: a wrong curve_length is caught by the 2% check', () => {
  const gltf = parseGlb(readFileSync(GLB));
  const node = gltf.json.nodes.find((n) => n.name === 'TRACK_CENTERLINE');
  node.extras = { ...(node.extras || {}), curve_length: (node.extras.curve_length || 900) * 1.1 };
  const track = Track.fromGltf(gltf);
  const err = Math.abs(track.length - track.extras.curve_length) / track.extras.curve_length;
  assert.ok(err > 0.02, 'the check would have passed a 10% wrong length');
});

test('G1 negative: a surface with faces on the centerline object is rejected', () => {
  const gltf = parseGlb(readFileSync(GLB));
  const cl = gltf.json.nodes.find((n) => n.name === 'TRACK_CENTERLINE');
  const surf = gltf.json.nodes.find((n) => n.name === 'TRACK_SURFACE');
  cl.mesh = surf.mesh; // now it has triangles
  assert.throws(() => Track.fromGltf(gltf), /edges only/);
});
