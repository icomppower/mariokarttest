# Dusk Circuit

A small kart racer where **Blender is the content pipeline**. The track, the
scenery, and the four karts are authored in Blender and exported to `.glb`;
the game code never generates gameplay geometry. Race logic is a headless,
seeded, deterministic simulation; Three.js is only the render layer.

Play: `npm ci && npm run serve` → http://localhost:4173/ (↑/W throttle, ↓/S brake, ←/→ steer, R restart).
Deployed by GitHub Actions to GitHub Pages on every push to `main` (enable
Pages once: Settings → Pages → Source: GitHub Actions).

Everything here is an original design — no franchise lookalikes in karts,
characters, or theming.

## Layout

```
index.html        page + import map (no bundler)
src/sim/          race.js, ai.js, track.js, rng.js, gltf.js, geom.js — zero DOM/Three.js imports
src/render/       scene.js, loaders.js, hud.js, input.js — Three.js only
src/main.js       bootstrap + fixed-step loop
assets/           track.glb, karts/*.glb, scenery/*.glb   (exports, committed)
blender/          track.blend, kart_*.blend, scenery.blend (editable sources, committed)
tools/            build_assets.py (bpy), blender_export.py (contract), validate_glb.py,
                  validate_workflow.js, assemble_dist.sh, serve.js
tests/            sim.test.js, track.test.js (node:test), smoke.spec.js (Playwright)
verify.sh  SPEC.md  DECISIONS.md  STATE.md  TODO.md
```

## The Blender edit loop

1. Open a source file in Blender — `blender/track.blend`, `blender/scenery.blend`,
   or `blender/kart_<name>.blend`.
2. Edit. Keep the names in the contract (SPEC.md): `TRACK_SURFACE`,
   `TRACK_CENTERLINE` (edges only, one closed loop, custom property
   `curve_length`), `TRACK_START` (empty), `PAD_*` (empties), `WALL_*`
   (collision meshes, hidden in game). Everything else is scenery.
   Kart wheels sit on Z = 0, long axis is Y, front faces −Y; name wheels
   `WHEEL_FL/FR/RL/RR` to have them spin and steer.
3. Re-export without regenerating:

   ```sh
   python tools/build_assets.py --from-blend
   ```

   This opens each `.blend`, validates the contract, and rewrites the `.glb`s.
   A broken contract fails with a named error (e.g. `CONTRACT ERROR: missing
   object TRACK_CENTERLINE`) and does not write the file.
4. `./verify.sh`, then commit both the `.blend` and the `.glb`.

To regenerate the sources from the script instead (this **overwrites** the
`.blend` files), run `python tools/build_assets.py`.

`tools/build_assets.py` needs Blender as a Python module: `pip install bpy==5.0.1`
(see `requirements.txt`). Node dependencies are in `package.json`.

## Single-file build

`node tools/build_artifact.mjs` writes `dist/dusk-circuit-standalone.html`:
the same modules concatenated, the `.glb` assets inlined as base64, and
three.js loaded from jsdelivr via the import map. Hand that one file around
or host it anywhere static. `--fragment` emits the same page without the
document skeleton for hosts that wrap pages themselves.

## Verify

```sh
./verify.sh              # G0–G4, incl. the bpy round trip
./verify.sh --no-blender # same without bpy (CI without Blender)
npm test                 # node:test only
npm run smoke            # Playwright only
```

## Deploy

`.github/workflows/pages.yml` runs the sim/track tests and asset validation,
assembles `dist/` with `tools/assemble_dist.sh` (page, modules, assets, and
only the Three.js files the import map references), and publishes it with
`actions/deploy-pages`. The same `dist/` is smoked locally by `verify.sh`.
