// Bootstrap: load assets, build sim + scene, run the fixed-step loop.
import * as THREE from 'three';
import { Race, DT, COUNTDOWN_TICKS } from './sim/race.js';
import { aiInput } from './sim/ai.js';
import { createScene } from './render/scene.js';
import { loadTrack, loadKart } from './render/loaders.js';
import { createHud } from './render/hud.js';
import { createInput } from './render/input.js';

const params = new URLSearchParams(location.search);
const TEST = params.get('test') === '1';
const SEED = params.get('seed') || 'dusk';
const LAPS = Math.max(1, parseInt(params.get('laps') || '3', 10));
const AUTOPILOT = params.get('autopilot') === '1';
const TRACK_URL = params.get('track') || './assets/track.glb';
// Test fixture (?test=1): 320x180, pixel ratio 1, shadows off, real materials.
// It exists so the Playwright p95 frame-time gate is stable on a software GPU.
const SHADOWS = params.has('shadows') ? params.get('shadows') !== '0' : !TEST;
const RES = (params.get('res') || (TEST ? '320x180' : '640x360')).split('x').map(Number);
const MATERIALS = params.get('materials') || 'standard';
const KART_URLS = ['ember', 'tideglass', 'ironmoth', 'nightjar'].map((n) => `./assets/karts/${n}.glb`);
const PLAYER = 0;

const hud = createHud(document.getElementById('hud'));
const stats = { frameTimes: [], workTimes: [], frames: 0 };
const api = { race: null, track: null, stats, ready: null, error: null, setInput: null, restart: null };
window.__dusk = api;

async function boot() {
  const view = createScene(document.getElementById('app'), { test: TEST, shadows: SHADOWS, maxWidth: RES[0], maxHeight: RES[1] });
  const input = createInput(window);
  api.setInput = (v) => input.setOverride(v);

  const [{ track, root, merged }, ...karts] = await Promise.all([loadTrack(TRACK_URL, { materials: MATERIALS }), ...KART_URLS.map(loadKart)]);
  api.track = track;
  api.merged = merged;
  view.scene.add(root);
  for (const k of karts) view.scene.add(k.group);

  let race;
  function newRace() {
    if (race) hud.els.results.hidden = true;
    race = new Race({ track, seed: SEED, kartCount: karts.length, laps: LAPS, external: AUTOPILOT ? [] : [PLAYER] });
    api.race = race;
    for (let i = 0; i < karts.length; i++) syncKart(karts[i], race.karts[i], 0);
    view.follow(race.karts[PLAYER], 1, 'intro');
  }
  api.restart = newRace;
  newRace();
  hud.ready();

  let last = performance.now();
  let acc = 0;
  let prevRaf = null;
  function frame(now) {
    requestAnimationFrame(frame);
    if (prevRaf !== null) {
      stats.frameTimes.push(now - prevRaf);
      if (stats.frameTimes.length > 900) stats.frameTimes.shift();
    }
    prevRaf = now;
    const t0 = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    if (input.pressed('KeyR')) newRace();
    let steps = 0;
    while (acc >= DT && steps < 6) {
      const inp = input.read(race.time);
      race.step({ [PLAYER]: inp });
      acc -= DT;
      steps++;
    }
    for (let i = 0; i < karts.length; i++) syncKart(karts[i], race.karts[i], dt);
    view.follow(race.karts[PLAYER], dt, race.tick < 60 ? 'intro' : 'chase');
    hud.update(race, race.karts[PLAYER]);
    view.render();
    stats.workTimes.push(performance.now() - t0);
    if (stats.workTimes.length > 900) stats.workTimes.shift();
    stats.frames++;
  }
  requestAnimationFrame(frame);
}

function syncKart(model, k, dt) {
  model.group.position.set(k.x, k.y, k.z);
  model.group.rotation.set(0, k.heading, 0);
  // Lean into slope: pitch from the sim's forward slope, tiny roll from steering.
  model.group.rotation.x = -Math.atan(k.slope);
  model.group.rotation.z = -k.steerAngle * 0.15 * Math.min(1, Math.abs(k.speed) / 15);
  for (const [name, w] of Object.entries(model.wheels)) {
    w.rotation.x = k.wheelSpin;
    w.rotation.y = name[0] === 'F' ? k.steerAngle : 0;
    w.rotation.order = 'YXZ';
  }
}

api.ready = boot().catch((err) => {
  console.error(err);
  api.error = err;
  hud.error(err);
  throw err;
});
