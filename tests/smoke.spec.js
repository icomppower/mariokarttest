// G2 gate: headless Chromium loads the page, sees the countdown, drives 10 s of
// scripted input, HUD shows lap 1 and non-zero speed, p95 frame time < 20 ms.
import { test, expect } from '@playwright/test';

const p95 = (arr) => {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};

test('smoke: countdown, scripted driving, HUD, frame time', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/index.html?test=1&seed=7');
  await expect(page.locator('#countdown')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#countdown')).toHaveText(/^[123]$/);
  await page.evaluate(() => window.__dusk.ready);

  // Scripted input: full throttle, then a gentle left through the first bend.
  await page.evaluate(() => {
    window.__dusk.stats.frameTimes.length = 0;
    window.__dusk.setInput((t) => ({ throttle: 1, steer: t < 8.5 ? 0 : 0.35 }));
  });
  await page.waitForTimeout(10_000);

  const snap = await page.evaluate(() => {
    const d = window.__dusk;
    const k = d.race.karts[0];
    return {
      phase: d.race.phase, tick: d.race.tick, speed: k.speed, lap: k.lap, s: k.s, offTrack: k.offTrack,
      hudLap: document.querySelector('#lap').textContent, hudSpeed: document.querySelector('#speed').textContent,
      frameTimes: d.stats.frameTimes.slice(60), workTimes: d.stats.workTimes.slice(60), frames: d.stats.frames,
    };
  });
  await page.screenshot({ path: testInfo.outputPath('smoke.png') });
  const fp95 = p95(snap.frameTimes);
  const wp95 = p95(snap.workTimes);
  console.log(`  ticks=${snap.tick} speed=${snap.speed.toFixed(1)} m/s s=${snap.s.toFixed(0)} lap=${snap.lap} hud=${snap.hudLap}/${snap.hudSpeed}km/h frames=${snap.frames} p95 frame=${fp95.toFixed(1)}ms work=${wp95.toFixed(1)}ms`);
  testInfo.annotations.push({ type: 'p95_frame_ms', description: fp95.toFixed(2) });
  expect(errors, 'page errors').toEqual([]);
  expect(snap.phase).toBe('racing');
  expect(snap.hudLap).toMatch(/^1\/3$/);
  expect(snap.speed).toBeGreaterThan(1);
  expect(Number(snap.hudSpeed)).toBeGreaterThan(0);
  expect(snap.frameTimes.length).toBeGreaterThan(200);
  expect(fp95).toBeLessThan(20);
});

test('visual: 640x360 with shadows renders without errors (screenshot)', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/index.html?test=1&seed=7&res=640x360&shadows=1&autopilot=1');
  await page.evaluate(() => window.__dusk.ready);
  await page.waitForTimeout(9000);
  const info = await page.evaluate(() => ({ merged: window.__dusk.merged, calls: window.__dusk.race.tick, hud: document.querySelector('#speed').textContent }));
  await page.screenshot({ path: testInfo.outputPath('visual.png') });
  console.log(`  scenery merged: ${info.merged.instances} instances -> ${info.merged.meshes} meshes; speed ${info.hud} km/h`);
  expect(errors).toEqual([]);
  expect(Number(info.hud)).toBeGreaterThan(0);
});

test('negative: a missing track asset surfaces an error instead of a silent page', async ({ page }) => {
  await page.goto('/index.html?test=1&track=assets/does-not-exist.glb');
  await expect(page.locator('#error')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#error')).toContainText('HTTP 404');
  await expect(page.locator('#countdown')).toBeHidden();
});

test('negative: a glb that breaks the Blender contract is rejected by name', async ({ page }) => {
  // A kart file has no TRACK_SURFACE: the sim loader must say so.
  await page.goto('/index.html?test=1&track=assets/karts/ember.glb');
  await expect(page.locator('#error')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#error')).toContainText('TRACK_SURFACE');
});
