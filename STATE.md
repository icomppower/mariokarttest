# STATE — what is real

Session: Claude Code on the web, 2026-09-08. Repo was **empty** at start; the
prototype `dusk-circuit-kart.html` named in the brief was not in the repo or
on disk, so the sim was written from scratch against the brief's contract.

## Preflight

| Check | Result |
|---|---|
| `CLAUDE_CODE_ENVIRONMENT_NAME` | **unset** (runner reports `CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE=cloud_default`). The substantive requirement behind the check held, so the build proceeded; recorded here as a discrepancy. |
| `python -c "import bpy"` | Blender **5.0.1** as a module, Python 3.11.15, numpy 1.26.4 |
| Playwright Chromium | Pre-installed by the environment (`/opt/pw-browsers/chromium-1194`, Playwright 1.56.1). `npx playwright install` was **not** run (environment policy: browsers are pre-provisioned). |
| Node / npm | v22.22.2 / 10.9.7; `three@0.185.1` installed from the registry |

## G0 — Extract sim ✅

`node --test tests/sim.test.js` on a test-only ribbon fixture (no Blender yet):

- 4 karts, 3 laps, seed 42: finishes in 4941 ticks (82.3 s sim time); state-log
  SHA-256 identical across two runs (`d519149ce10123e2…`).
- Negative: seed 43 gives a different hash.
- Negative (gate has teeth): an external driver that uses `Math.random`
  produces differing hashes between runs.
- Also: ranking = finish order; laps need the full distance and reversing
  over the line un-counts; walls block; pads boost above the speed cap;
  `widthAt` measures the ribbon.

## G1 — Assets from Blender ✅

`python tools/build_assets.py` (bpy 5.0.1) writes `blender/{track,scenery,kart_*}.blend`
and exports `assets/track.glb` (789 KB, 160 nodes), `assets/karts/*.glb`
(4 karts, 44–71 KB), `assets/scenery/*.glb` (7 prototypes).

`node --test tests/track.test.js` against the committed `assets/track.glb`:

- Centerline: 457 vertices, polyline 913.14 m vs Blender `curve_length`
  913.23 m → **0.010 %** (gate: < 2 %).
- 100/100 random points on `TRACK_SURFACE` classify on-track;
  100/100 points offset 3–10 m beyond the measured edge classify off-track.
- Measured half-widths fall inside the authored range (asphalt 5.2–9.2 m + 1 m curbs).
- `TRACK_START` is on the surface at the first centerline vertex, heading aligned.
- 4 AI karts finish 3 laps in 118.1 s (laps 32–40 s), hash-identical across runs.
- Negatives: renamed `TRACK_CENTERLINE` → `missing object TRACK_CENTERLINE`;
  a 10 % wrong `curve_length` trips the 2 % check; triangles on the
  centerline object → `must be edges only`.

`python tools/validate_glb.py assets/track.glb` and `--kart assets/karts/*.glb` pass.

## G2 — Renderer on modules ✅

`npx playwright test` (headless Chromium 1194 via Playwright 1.56.1, software
GL: ANGLE/SwiftShader) against `tools/serve.js`:

- `index.html?test=1&seed=7`: countdown visible with `3/2/1`, 10 s of
  scripted input (full throttle, then a left), HUD shows `LAP 1/3` and
  46 km/h, kart speed 12.8 m/s, phase `racing`, no page errors.
- **p95 frame time 16.8 ms** (598 frames in 10 s) on the **test fixture**:
  320×180, pixel ratio 1, shadows off, real materials. CPU work per frame
  p95 1.1 ms. The fixture exists because SwiftShader is fill-rate bound:
  640×360 with shadows runs at p95 66–83 ms in this container, which says
  nothing about the JS side. The shadowed 640×360 path is still exercised
  by a separate visual run (screenshot, no page errors, HUD speed 90 km/h).
- Static scenery is merged per material at load: 325 instance meshes → 19 draw calls.
- Negatives: a missing track URL shows the error overlay with `HTTP 404`;
  a kart file offered as the track fails with `missing object TRACK_SURFACE`.

## G3 — Round trip ✅ (`verify.sh` G3a/G3b/G3c)

- `python tools/build_assets.py --from-blend --out <tmp>` re-exports all
  12 `.glb` files **byte-identical** to the committed ones (`cmp`), twice.
- Negative: copy `track.blend`, rename `TRACK_CENTERLINE` → `TRACK_CENTRELINE`
  with bpy, run `--from-blend` → exit code 2,
  `CONTRACT ERROR: missing object TRACK_CENTERLINE`, and no `track.glb` written.
- Negative: `validate_glb.py assets/karts/ember.glb` (a kart as a track) → exit 1, names `TRACK_SURFACE`.

## G4 — Deploy prep ✅ (PR instead of live deploy, per the brief)

- `.github/workflows/pages.yml`: on push to `main` → `npm ci`, sim + track
  tests, `validate_glb`, `tools/assemble_dist.sh` (31 files, 3.4 MB: page,
  modules, assets, and only the three.js files the import map references),
  `configure-pages` (enablement on) → `upload-pages-artifact` → `deploy-pages`.
- `act` is not installed here; `tools/validate_workflow.js` is the dry run:
  parses the YAML and checks triggers, permissions, pinned `uses`, the
  `github-pages` environment, and that tests run before deploy.
  Negative: the same file with the `deploy-pages` step removed is rejected by name.
- Playwright smoke passes against `dist/` served statically (this is what
  caught a missing transitive addon file, `SkeletonUtils.js`, on the first try).
- **Live deploy attempt.** Mid-session Johnny asked for a live link, so
  `main` was created from the branch tip (commit `5f06ab6`) and the workflow
  ran: run #1 passed `npm ci`, 15 sim/track tests, `validate_glb`, and the
  dist assembly, then **failed at `actions/configure-pages`** with
  `Create Pages site failed: Resource not accessible by integration` — the
  workflow token cannot create the Pages site. One-time fix, repo owner only:
  Settings → Pages → Build and deployment → Source: **GitHub Actions**, then
  re-run the workflow (or push to `main`). Expected URL:
  https://icomppower.github.io/mariokarttest/
- **Live link now:** the single-file build from `tools/build_artifact.mjs`
  (same modules concatenated, `.glb`s inlined as base64, three.js from
  jsdelivr) is published as a Claude artifact:
  https://claude.ai/code/artifact/fabf32c8-0920-487b-a86b-3a4578c04351
  The concatenated bundle was smoked headlessly with a local copy of three
  (91 km/h, no page errors); the CDN itself is unreachable from this
  container, so the CDN path is verified only by the artifact opening in a
  browser.
- Because `main` already carries G0–G4, the PR from this branch holds only
  the follow-up commit (standalone builder + this STATE update); the gate
  evidence is in its description.

## Not real / caveats

- No hand-modelled polish: all `.blend`s come from `tools/build_assets.py`
  (bpy 5.0.1). They open and edit normally; `--from-blend` keeps edits.
- `TRACK_CURVE` (the Bezier) is kept in `track.blend` for reference, but
  editing it does not re-sweep `TRACK_SURFACE`/`TRACK_CENTERLINE` (see TODO).
- The p95 gate is measured on the reduced fixture described above, not at
  full resolution with shadows.
- `CLAUDE_CODE_ENVIRONMENT_NAME` was unset (see Preflight).
