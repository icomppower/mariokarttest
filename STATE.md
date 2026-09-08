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

- 4 karts, 3 laps, seed 42: finishes in 4981 ticks (83.0 s sim time); state-log
  SHA-256 identical across two runs (`6353bdfbde098c89…`).
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
- 4 AI karts finish 3 laps in 118.5 s, hash-identical across runs.
- Negatives: renamed `TRACK_CENTERLINE` → `missing object TRACK_CENTERLINE`;
  a 10 % wrong `curve_length` trips the 2 % check; triangles on the
  centerline object → `must be edges only`.

`python tools/validate_glb.py assets/track.glb` and `--kart assets/karts/*.glb` pass.

## G2 — Renderer on modules — pending
## G3 — Round trip — pending
## G4 — Deploy prep — pending
