// Race simulation: kart physics, laps, ranking, boost pads, walls, AI hookup.
// Fixed timestep, seeded, no rendering. `Race(seed)` with the same inputs
// produces byte-identical state logs (see tests/sim.test.js).

import { makeRng } from './rng.js';
import { clamp, closestOnSegment2D, segmentIntersect2D, wrapAngle } from './geom.js';
import { aiInput, makeProfile } from './ai.js';

export const DT = 1 / 60;
export const COUNTDOWN_TICKS = 180;

export const PHYS = Object.freeze({
  maxSpeed: 30, // m/s (~108 km/h)
  reverseMax: 7,
  accel: 11,
  brake: 24,
  coast: 2.2,
  drag: 0.011, // v² drag coefficient
  maxYaw: 2.5, // rad/s at full grip
  offTrackMax: 11,
  offTrackDecel: 7,
  boostSpeed: 41,
  boostTicks: 80,
  boostAccel: 40,
  kartRadius: 1.0,
  slopeFactor: 0.45,
  checkpointFraction: 0.6,
});

const KART_NAMES = ['Ember', 'Tideglass', 'Ironmoth', 'Nightjar'];

export class Race {
  /**
   * @param {object} opts
   * @param {import('./track.js').Track} opts.track
   * @param {string|number} [opts.seed]
   * @param {number} [opts.kartCount]
   * @param {number} [opts.laps]
   * @param {number[]} [opts.external] kart ids driven by external input (players)
   * @param {boolean} [opts.log] keep a per-tick state log (tests)
   */
  constructor(opts) {
    if (!opts || !opts.track) throw new Error('Race needs a track');
    this.track = opts.track;
    this.seed = opts.seed === undefined ? 1 : opts.seed;
    this.rng = makeRng(this.seed);
    this.laps = opts.laps || 3;
    this.kartCount = opts.kartCount || 4;
    this.external = new Set(opts.external || []);
    this.logEnabled = !!opts.log;
    this.log = [];
    this.tick = 0;
    this.phase = 'countdown';
    this.karts = [];
    for (let i = 0; i < this.kartCount; i++) this.karts.push(this._spawn(i));
    this._updateRanks();
  }

  get time() {
    return this.tick * DT;
  }
  get countdownRemaining() {
    return Math.max(0, COUNTDOWN_TICKS - this.tick) * DT;
  }

  _spawn(i) {
    const t = this.track;
    const st = t.start;
    const fx = Math.sin(st.heading), fz = Math.cos(st.heading);
    const lx = fz, lz = -fx; // left normal
    const row = Math.floor(i / 2);
    const col = i % 2 === 0 ? 1 : -1;
    const back = 5 + row * 4.5;
    const side = col * 2.3;
    const x = st.x - fx * back + lx * side;
    const z = st.z - fz * back + lz * side;
    const gy = t.groundY(x, z, st.y + 5);
    const y = gy === null ? st.y : gy;
    const proj = t.project(x, y, z);
    return {
      id: i,
      name: KART_NAMES[i % KART_NAMES.length],
      x, y, z,
      heading: st.heading,
      speed: 0,
      s: proj.s,
      lateral: proj.lateral,
      lap: 0,
      dist: proj.s > t.length / 2 ? proj.s - t.length : proj.s, // continuous distance; grid sits behind the line
      lapStartTick: COUNTDOWN_TICKS,
      lapTimes: [],
      finished: false,
      finishTick: -1,
      rank: i + 1,
      boostTicks: 0,
      offTrack: false,
      lastSteer: 0,
      steerAngle: 0,
      wheelSpin: 0,
      slope: 0,
      lastInput: { throttle: 0, steer: 0 },
      controller: this.external.has(i) ? 'external' : 'ai',
      profile: makeProfile(this.rng),
      hitWall: false,
    };
  }

  /**
   * Advance one fixed tick. `inputs` maps kart id -> {throttle, steer} for
   * externally driven karts; missing entries mean no input.
   */
  step(inputs = {}) {
    const racing = this.tick >= COUNTDOWN_TICKS;
    if (this.phase === 'countdown' && racing) this.phase = 'racing';
    const karts = this.karts;
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      let inp;
      if (k.controller === 'external' && !k.finished) {
        inp = inputs[k.id] || { throttle: 0, steer: 0 };
      } else {
        inp = aiInput(this, k, k.profile);
      }
      k.lastInput = { throttle: clamp(inp.throttle || 0, -1, 1), steer: clamp(inp.steer || 0, -1, 1) };
      if (racing) this._integrate(k, k.lastInput);
    }
    if (racing) {
      this._kartCollisions();
      for (let i = 0; i < karts.length; i++) this._ground(karts[i]);
      for (let i = 0; i < karts.length; i++) this._progress(karts[i]);
      this._updateRanks();
      if (this.phase === 'racing' && karts.every((k) => k.finished)) this.phase = 'finished';
    }
    if (this.logEnabled) this._logTick();
    this.tick++;
  }

  _integrate(k, inp) {
    const P = PHYS;
    const boosting = k.boostTicks > 0;
    if (boosting) k.boostTicks--;
    let a = 0;
    if (boosting) {
      a = P.boostAccel;
    } else if (inp.throttle > 0) {
      a = P.accel * inp.throttle;
    } else if (inp.throttle < 0) {
      a = k.speed > 0.2 ? -P.brake : -P.accel * 0.6; // brake, then reverse
    } else {
      a = k.speed > 0 ? -P.coast : k.speed < 0 ? P.coast : 0;
    }
    a -= P.drag * k.speed * Math.abs(k.speed);
    a -= 9.81 * k.slope * P.slopeFactor;
    if (k.offTrack) {
      if (k.speed > P.offTrackMax) a -= P.offTrackDecel;
    }
    k.speed += a * DT;
    const top = boosting ? P.boostSpeed : k.offTrack ? Math.max(P.offTrackMax, k.speed - P.offTrackDecel * DT) : P.maxSpeed;
    k.speed = clamp(k.speed, -P.reverseMax, Math.max(top, 0));
    if (Math.abs(k.speed) < 0.02 && inp.throttle === 0) k.speed = 0;

    // Steering: grip falls off at speed, and you cannot turn standing still.
    const sp = Math.abs(k.speed);
    const grip = clamp(sp / 5, 0, 1) / (1 + sp / 45);
    const yaw = inp.steer * P.maxYaw * grip * (k.speed < 0 ? -1 : 1);
    k.heading = wrapAngle(k.heading + yaw * DT);
    k.steerAngle += (inp.steer * 0.45 - k.steerAngle) * 0.3;
    k.lastSteer = inp.steer;

    const px = k.x, pz = k.z;
    k.x += Math.sin(k.heading) * k.speed * DT;
    k.z += Math.cos(k.heading) * k.speed * DT;
    k.wheelSpin += k.speed * DT / 0.32;
    this._walls(k, px, pz);
  }

  _walls(k, px, pz) {
    const walls = this.track.walls;
    if (walls.size === 0) return;
    const r = PHYS.kartRadius;
    k.hitWall = false;
    for (let iter = 0; iter < 2; iter++) {
      const x0 = Math.min(px, k.x) - r, x1 = Math.max(px, k.x) + r;
      const z0 = Math.min(pz, k.z) - r, z1 = Math.max(pz, k.z) + r;
      const cands = walls.grid.queryBox(x0, z0, x1, z1);
      if (cands.length === 0) return;
      cands.sort((a, b) => a - b); // deterministic order regardless of bucket layout
      let hit = false;
      let last = -1;
      for (let c = 0; c < cands.length; c++) {
        const ei = cands[c];
        if (ei === last) continue;
        last = ei;
        const [ax, az, bx, bz] = walls.edges[ei];
        const ex = bx - ax, ez = bz - az;
        const el = Math.hypot(ex, ez) || 1;
        let nx = ez / el, nz = -ex / el;
        // Normal should point toward the side the kart came from.
        if ((px - ax) * nx + (pz - az) * nz < 0) {
          nx = -nx;
          nz = -nz;
        }
        const cp = closestOnSegment2D(ax, az, bx, bz, k.x, k.z);
        const crossed = segmentIntersect2D(px, pz, k.x, k.z, ax, az, bx, bz) !== null;
        if (!crossed && cp.d2 >= r * r) continue;
        // Resolve: place the kart r away from the edge on the origin side and
        // scrub speed by how head-on the impact was.
        const base = crossed ? closestOnSegment2D(ax, az, bx, bz, px, pz) : cp;
        k.x = base.x + nx * r;
        k.z = base.z + nz * r;
        const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
        const headOn = Math.abs(fx * nx + fz * nz);
        k.speed *= 1 - 0.7 * headOn;
        k.hitWall = true;
        hit = true;
      }
      if (!hit) return;
    }
  }

  _kartCollisions() {
    const ks = this.karts;
    const r2 = PHYS.kartRadius * 2;
    for (let i = 0; i < ks.length; i++) {
      for (let j = i + 1; j < ks.length; j++) {
        const a = ks[i], b = ks[j];
        const dx = b.x - a.x, dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= r2 || d < 1e-6) continue;
        const push = (r2 - d) / 2;
        const nx = dx / d, nz = dz / d;
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
        // Faster kart loses a bit more; both shed some speed.
        a.speed *= 0.92;
        b.speed *= 0.92;
      }
    }
  }

  _ground(k) {
    const t = this.track;
    const gy = t.groundY(k.x, k.z, k.y + 3);
    if (gy !== null) {
      k.offTrack = false;
      k.y = gy;
      const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
      const yf = t.groundY(k.x + fx * 1.2, k.z + fz * 1.2, k.y + 3);
      const yb = t.groundY(k.x - fx * 1.2, k.z - fz * 1.2, k.y + 3);
      k.slope = yf !== null && yb !== null ? clamp((yf - yb) / 2.4, -1, 1) : 0;
    } else {
      k.offTrack = true;
      k.slope = 0;
      const c = t.sample(k.s);
      k.y += (c.y - k.y) * 0.15;
    }
    // Boost pads
    if (k.boostTicks === 0) {
      const pads = t.pads;
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        const dx = k.x - p.x, dz = k.z - p.z;
        if (dx * dx + dz * dz <= p.radius * p.radius) {
          k.boostTicks = PHYS.boostTicks;
          k.speed = Math.max(k.speed, PHYS.maxSpeed * 0.9);
          break;
        }
      }
    }
  }

  _progress(k) {
    const t = this.track;
    const L = t.length;
    const proj = t.project(k.x, k.y, k.z);
    let ds = proj.s - k.s;
    if (ds < -L / 2) ds += L;
    else if (ds > L / 2) ds -= L;
    k.s = proj.s;
    k.lateral = proj.lateral;
    // A kart moves well under a metre per tick; a bigger jump is a teleport
    // (tests) or a projection glitch and must not count as progress.
    if (Math.abs(ds) < 25) k.dist += ds;
    const newLap = Math.max(0, Math.floor(k.dist / L));
    while (newLap > k.lap) {
      k.lap++;
      k.lapTimes.push((this.tick - k.lapStartTick) * DT);
      k.lapStartTick = this.tick;
    }
    while (newLap < k.lap) {
      // Crossed the line backwards: un-count so the lap can be re-earned.
      k.lap--;
      const lt = k.lapTimes.pop() || 0;
      k.lapStartTick = this.tick - Math.round(lt / DT);
    }
    if (!k.finished && k.lap >= this.laps) {
      k.finished = true;
      k.finishTick = this.tick;
    }
  }

  progressOf(k) {
    return k.dist;
  }

  _updateRanks() {
    const order = this.karts.slice().sort((a, b) => {
      if (a.finished && b.finished) return a.finishTick - b.finishTick || a.id - b.id;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return this.progressOf(b) - this.progressOf(a) || a.id - b.id;
    });
    for (let i = 0; i < order.length; i++) order[i].rank = i + 1;
    this.standings = order;
  }

  _logTick() {
    const parts = [String(this.tick)];
    for (const k of this.karts) {
      parts.push(
        `${k.id}:${k.x.toFixed(4)},${k.y.toFixed(4)},${k.z.toFixed(4)},${k.heading.toFixed(5)},${k.speed.toFixed(4)},${k.lap},${k.s.toFixed(3)},${k.rank}${k.offTrack ? ',o' : ''}${k.boostTicks ? ',b' : ''}`
      );
    }
    this.log.push(parts.join('|'));
  }

  /** Run until every kart finishes or `maxTicks` elapse. Returns the tick count. */
  runToFinish(maxTicks = 60 * 60 * 10, inputsFn = null) {
    while (this.phase !== 'finished' && this.tick < maxTicks) {
      this.step(inputsFn ? inputsFn(this) : undefined);
    }
    return this.tick;
  }
}
