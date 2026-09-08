# Dusk Circuit — SPEC

A kart racer where **Blender is the content pipeline**. Track, scenery, and
karts are authored in Blender (headless `bpy` here, editable `.blend` sources
committed) and exported to `.glb`. The code never generates gameplay geometry.

## Architecture

```
src/sim/      race logic, zero DOM / Three.js imports. Runs in Node tests and in the page.
src/render/   Three.js render layer only: scene, loaders, HUD, input.
assets/       .glb exports (committed): track.glb, karts/*.glb, scenery/*.glb
blender/      .blend sources (committed): track.blend, kart_*.blend, scenery.blend
tools/        build_assets.py (bpy), blender_export.py (contract + export), validate_glb.py, serve.js
tests/        sim.test.js, track.test.js (node:test), smoke.spec.js (Playwright)
```

- **Seeded determinism.** `new Race({ track, seed })` with the same inputs
  produces byte-identical state logs. The only random source is
  `src/sim/rng.js` (mulberry32 seeded with FNV-1a of the seed). No
  `Math.random`, no wall-clock, no iteration over object keys in the sim.
- **Fixed step.** 60 Hz (`DT = 1/60`). The renderer accumulates real time
  and steps the sim in whole ticks.
- **Coordinates.** glTF / Three.js space: Y up, 1 unit = 1 m. Kart heading
  `θ` has forward vector `(sin θ, 0, cos θ)`, so `θ = 0` faces +Z and
  `Object3D.rotation.y = θ` orients a model whose forward is +Z.

## Blender contract

`assets/track.glb` must contain, by **object name**:

| Object | Type | Purpose |
|---|---|---|
| `TRACK_SURFACE` | mesh | drivable; on-track test = raycast straight down hits this |
| `TRACK_CENTERLINE` | mesh, **edges only** (no faces), one closed loop | sampled into the spline for laps, AI, and ranking. The vertex nearest `TRACK_START` is the start line; the loop is walked in the direction of `TRACK_START`'s forward axis, so exporter vertex order does not matter. Custom property `curve_length` (metres, from the source Bezier curve) is exported as glTF `extras` |
| `TRACK_START` | empty | grid origin + heading (the empty's local −Y in Blender / +Z in glTF) |
| `PAD_*` | empty | boost pad centre; optional custom property `radius` (default 2.5 m) |
| `WALL_*` | mesh | collision only; the renderer hides it |
| everything else | mesh | scenery, rendered with shadows, no collision |

Units: 1 Blender unit = 1 m. Forward = −Y in Blender; the glTF exporter's
Y-up conversion maps Blender −Y to glTF **+Z**, which is the forward axis the
loader and sim use. Apply all transforms before export (`export_apply=True`).

`tools/blender_export.py` is the single place these names live; both
`build_assets.py` (generate + validate + export) and `validate_glb.py`
(check an exported `.glb`) import from it.

### Track authoring rules

- The centerline is a closed Bezier curve. `build_assets.py` samples it at
  ~2 m spacing to produce `TRACK_CENTERLINE`, and records the true curve
  length in `curve_length`.
- `TRACK_SURFACE` is the sweep of that curve (asphalt + curbs, one mesh,
  multiple material slots). Curbs are drivable.
- Walls are separate `WALL_*` meshes. The sim treats every wall edge in the
  XZ projection as a barrier, so walls should be simple prisms.

### Kart `.glb`

Any mesh. Wheels touch the ground plane (Blender Z = 0), long axis forward
(−Y in Blender). The loader recenters in XZ, grounds the lowest vertex to
y = 0, and scales the longest horizontal dimension to **2.4 m**. Objects
named `WHEEL_FL`, `WHEEL_FR`, `WHEEL_RL`, `WHEEL_RR` get spun (all) and
steered (front pair).

## Sim contract (`src/sim/`)

- `Track` — built from a parsed `.glb` (`Track.fromGltf`) or a plain
  definition (tests). Provides `sample(s)`, `project(x,y,z)`, `groundY`,
  `onTrack`, `widthAt(s)` (measured by marching raycasts outward from the
  centerline), `curvatureAt(s)`.
- `Race` — `step(inputs)` per tick; `karts[]` with `x,y,z,heading,speed,
  lap,dist,rank,finished,...`; `phase` is `countdown → racing → finished`.
  Lap counting uses a continuous distance-along-track counter, so reversing
  across the line un-counts the lap. Ranking is by finish tick, then distance.
- `ai.js` — deterministic driver: look-ahead point on the centerline plus a
  per-kart lane offset, curvature-based throttle, unstick logic.

## Gates

See STATE.md for the evidence of each gate and its negative test.
