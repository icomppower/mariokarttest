// AI driver. Pure function of (race, kart) plus a per-kart profile drawn from
// the race RNG, so the whole thing stays deterministic.

import { clamp, wrapAngle } from './geom.js';

export function makeProfile(rng) {
  return {
    lane: rng.range(-0.55, 0.55), // fraction of half-width, negative = right
    caution: rng.range(0.6, 1.3), // how hard it brakes for corners
    gain: rng.range(1.6, 2.6), // steering gain
    pace: rng.range(0.9, 1.0), // throttle ceiling
    lookahead: rng.range(6, 10),
    // Unstick state
    stuckTicks: 0,
    reverseTicks: 0,
  };
}

export function aiInput(race, kart, profile) {
  const track = race.track;
  const p = profile;
  // Unstick: if crawling with throttle applied for 1.5 s, reverse for 1 s.
  if (p.reverseTicks > 0) {
    p.reverseTicks--;
    return { throttle: -1, steer: -kart.lastSteer || 0 };
  }
  if (race.phase === 'racing' && kart.speed < 1.5 && !kart.finished) {
    p.stuckTicks++;
    if (p.stuckTicks > 90) {
      p.stuckTicks = 0;
      p.reverseTicks = 60;
    }
  } else {
    p.stuckTicks = 0;
  }

  const ahead = p.lookahead + kart.speed * 0.55;
  const targetS = kart.s + ahead;
  const t = track.sample(targetS);
  const w = track.widthAt(targetS);
  const lat = p.lane * (p.lane > 0 ? w.left : w.right) * 0.8;
  const tx = t.x + t.nx * lat;
  const tz = t.z + t.nz * lat;
  const desired = Math.atan2(tx - kart.x, tz - kart.z);
  const diff = wrapAngle(desired - kart.heading);
  let steer = clamp(diff * p.gain, -1, 1);

  // Kart directly ahead and slower: lift and move over rather than ram it.
  const fx = Math.sin(kart.heading), fz = Math.cos(kart.heading);
  let blocked = 0;
  let blockSide = 0;
  for (const o of race.karts) {
    if (o === kart) continue;
    const rx = o.x - kart.x, rz = o.z - kart.z;
    const ahead = rx * fx + rz * fz;
    const side = rx * fz - rz * fx; // positive = to the left
    if (ahead > 0 && ahead < 5 + kart.speed * 0.25 && Math.abs(side) < 2.4 && o.speed < kart.speed + 2) {
      blocked = Math.max(blocked, 1 - ahead / (5 + kart.speed * 0.25));
      blockSide = side;
    }
  }
  if (blocked > 0) steer = clamp(steer + (blockSide > 0 ? -0.5 : 0.5) * blocked, -1, 1);

  // Throttle: ease off for upcoming curvature and when pointing away from the line.
  const k1 = Math.abs(track.curvatureAt(kart.s + 12));
  const k2 = Math.abs(track.curvatureAt(kart.s + 28));
  const k = Math.max(k1, k2 * 0.7);
  let throttle = p.pace - clamp(k * 22 * p.caution * (kart.speed / 20), 0, 0.7);
  if (Math.abs(diff) > 1.2) throttle = Math.min(throttle, 0.35);
  if (Math.abs(diff) > 0.6 && kart.speed > 18) throttle = Math.min(throttle, 0.1);
  if (blocked > 0.5) throttle = Math.min(throttle, 0.4);
  return { throttle: clamp(throttle, -1, 1), steer };
}
