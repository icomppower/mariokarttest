// G0 gate: headless sim determinism, laps, ranking, AI, walls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Race, COUNTDOWN_TICKS, PHYS } from '../src/sim/race.js';
import { ribbonTrack } from './fixtures/ribbon.js';

const sha256 = (lines) => createHash('sha256').update(lines.join('\n')).digest('hex');

function runRace(seed, opts = {}) {
  const track = ribbonTrack();
  const race = new Race({ track, seed, kartCount: 4, laps: 3, log: true, ...opts });
  const ticks = race.runToFinish(60 * 60 * 8);
  return { race, ticks, hash: sha256(race.log) };
}

test('G0: 4 karts, 3 laps, fixed seed finishes and is byte-identical across runs', () => {
  const a = runRace(42);
  const b = runRace(42);
  assert.equal(a.race.phase, 'finished', `race did not finish in ${a.ticks} ticks`);
  assert.equal(a.race.karts.length, 4);
  for (const k of a.race.karts) {
    assert.equal(k.lap, 3, `kart ${k.id} finished with lap=${k.lap}`);
    assert.equal(k.lapTimes.length, 3);
    assert.ok(k.finishTick > COUNTDOWN_TICKS);
  }
  assert.equal(a.hash, b.hash, 'state-log SHA-256 differs between two runs with the same seed');
  assert.equal(a.log?.length ?? a.race.log.length, b.race.log.length);
  console.log(`  seed 42: ${a.ticks} ticks (${(a.ticks / 60).toFixed(1)} s), log sha256 ${a.hash.slice(0, 16)}…`);
});

test('G0 negative: a different seed produces a different state-log hash', () => {
  const a = runRace(42);
  const b = runRace(43);
  assert.notEqual(a.hash, b.hash);
});

test('G0 negative: the hash check has teeth (a nondeterministic controller is caught)', () => {
  // Deliberately broken input: an external driver that consults Math.random.
  const noisy = (race) => ({ 0: { throttle: 1, steer: (Math.random() - 0.5) * 0.4 } });
  const mk = () => {
    const race = new Race({ track: ribbonTrack(), seed: 7, kartCount: 4, laps: 1, log: true, external: [0] });
    race.runToFinish(60 * 90, noisy);
    return sha256(race.log);
  };
  assert.notEqual(mk(), mk(), 'nondeterministic input should have changed the hash');
});

test('ranking follows progress and finish order', () => {
  const { race } = runRace(42);
  const st = race.standings;
  for (let i = 1; i < st.length; i++) {
    assert.ok(st[i - 1].finishTick <= st[i].finishTick, 'finish order must match ranks');
    assert.equal(st[i - 1].rank, i);
  }
  const ranks = race.karts.map((k) => k.rank).sort();
  assert.deepEqual(ranks, [1, 2, 3, 4]);
});

test('laps only count after the checkpoint; reversing across the line does not add a lap', () => {
  const track = ribbonTrack({ walls: false, pads: false });
  const race = new Race({ track, seed: 1, kartCount: 1, laps: 3, external: [0] });
  const k = race.karts[0];
  race.tick = COUNTDOWN_TICKS; // skip countdown
  // Drive forward over the line without having gone round: no lap.
  for (let i = 0; i < 240; i++) race.step({ 0: { throttle: 1, steer: 0 } });
  assert.ok(k.s > 0 && k.s < track.length / 2, 'kart should be just past the line');
  assert.equal(k.lap, 0);
  // Teleport to just before the line with the checkpoint reached, cross forward: lap 1.
  const near = track.sample(track.length - 3);
  Object.assign(k, { x: near.x, y: near.y, z: near.z, s: track.length - 3, dist: track.length - 3, heading: Math.atan2(near.tx, near.tz), speed: 10 });
  for (let i = 0; i < 60; i++) race.step({ 0: { throttle: 1, steer: 0 } });
  assert.equal(k.lap, 1);
  // Now reverse back across the line: lap goes back to 0, and forward again re-earns it.
  for (let i = 0; i < 420; i++) race.step({ 0: { throttle: -1, steer: 0 } });
  assert.equal(k.lap, 0, 'reversing over the line must un-count the lap');
  for (let i = 0; i < 240; i++) race.step({ 0: { throttle: 1, steer: 0 } });
  assert.equal(k.lap, 1);
});

test('walls stop a kart; boost pads raise speed above the normal cap', () => {
  const track = ribbonTrack();
  const race = new Race({ track, seed: 3, kartCount: 1, laps: 3, external: [0] });
  const k = race.karts[0];
  race.tick = COUNTDOWN_TICKS;
  // Aim straight at the first wall (outside of sample 60, left side).
  const c = track.sample(track.cum[60]);
  Object.assign(k, { x: c.x, y: c.y, z: c.z, heading: Math.atan2(c.nx, c.nz), speed: 20 });
  let hit = false;
  for (let i = 0; i < 120; i++) {
    race.step({ 0: { throttle: 1, steer: 0 } });
    if (k.hitWall) hit = true;
  }
  assert.ok(hit, 'kart should have hit the wall');
  assert.ok(track.project(k.x, k.y, k.z).lateral < 6.5 + 1.5, 'kart must not pass through the wall');
  // Boost pad at sample 90.
  const p = track.pads[0];
  Object.assign(k, { x: p.x, y: p.y, z: p.z, speed: 25, heading: 0 });
  race.step({ 0: { throttle: 1, steer: 0 } });
  assert.ok(k.boostTicks > 0, 'pad should trigger boost');
  for (let i = 0; i < 40; i++) race.step({ 0: { throttle: 1, steer: 0 } });
  assert.ok(k.speed > PHYS.maxSpeed, `boosted speed ${k.speed} should exceed cap ${PHYS.maxSpeed}`);
});

test('off-track karts are slowed and Track.widthAt measures the ribbon', () => {
  const track = ribbonTrack({ walls: false, pads: false });
  const w = track.widthAt(50);
  assert.ok(Math.abs(w.left - 6.5) < 0.6 && Math.abs(w.right - 6.5) < 0.6, JSON.stringify(w));
  const c = track.sample(50);
  assert.ok(track.onTrack(c.x, c.z, c.y + 3));
  assert.ok(!track.onTrack(c.x + c.nx * 9, c.z + c.nz * 9, c.y + 3));
});
