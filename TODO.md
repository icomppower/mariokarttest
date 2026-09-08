# TODO — out of scope for this pass (do not start)

- Items / weapons
- Multiplayer
- Audio
- Mobile app wrapper
- Procedural track generation (the track is authored in Blender by design)

## Nice-to-have follow-ups

- `build_assets.py --resweep`: rebuild `TRACK_SURFACE`/`TRACK_CENTERLINE`/pads from an edited `TRACK_CURVE` Bezier inside `track.blend`, keeping scenery and walls
- A `--no-blender` CI job (node tests + Playwright) on pull requests

- Drift / mini-boost mechanic
- Ghost replay from the deterministic state log
- Kart selection screen (all four karts are loaded; the player always drives Ember)
- Minimap from `TRACK_CENTERLINE`
