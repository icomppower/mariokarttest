#!/usr/bin/env bash
# Dusk Circuit verification. Green on a clean clone means every gate holds.
#   ./verify.sh            # everything (needs bpy for G3)
#   ./verify.sh --no-blender   # skip the bpy round trip (CI without Blender)
set -euo pipefail
cd "$(dirname "$0")"

BLENDER=1
for a in "$@"; do
  case "$a" in
    --no-blender) BLENDER=0 ;;
    *) echo "unknown flag $a" >&2; exit 64 ;;
  esac
done

step() { printf '\n\033[1;35m== %s\033[0m\n' "$*"; }
pass() { printf '\033[1;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }

step "deps: npm ci"
npm ci --no-audit --no-fund --silent
pass "npm ci"

step "G0 + G1: node --test (sim determinism, Blender track contract)"
node --test tests/sim.test.js tests/track.test.js
pass "node tests"

step "G1: validate committed .glb files against the contract"
python tools/validate_glb.py assets/track.glb
python tools/validate_glb.py --kart assets/karts/*.glb
pass "validate_glb"

if [ "$BLENDER" = 1 ]; then
  python -c "import bpy" 2>/dev/null || fail "bpy is not importable; run with --no-blender to skip G3"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  step "G3a: --from-blend re-export is byte-stable against the committed assets"
  python tools/build_assets.py --from-blend --out "$TMP/out" >"$TMP/export.log" 2>&1 || { cat "$TMP/export.log"; fail "--from-blend export"; }
  for f in track.glb karts/ember.glb karts/tideglass.glb karts/ironmoth.glb karts/nightjar.glb \
           scenery/tree_pine.glb scenery/tree_round.glb scenery/rock.glb scenery/crystal.glb scenery/lamp.glb scenery/banner.glb scenery/stand.glb; do
    cmp -s "assets/$f" "$TMP/out/$f" || fail "re-exported $f differs from the committed file (run tools/build_assets.py --from-blend and commit)"
  done
  pass "12 .glb files byte-identical"

  step "G3b (negative): a renamed object in track.blend fails --from-blend with a named error"
  mkdir -p "$TMP/blend"
  cp blender/*.blend "$TMP/blend/"
  python - "$TMP/blend/track.blend" <<'PY' >/dev/null 2>&1
import bpy, sys
bpy.ops.wm.open_mainfile(filepath=sys.argv[1])
bpy.data.objects["TRACK_CENTERLINE"].name = "TRACK_CENTRELINE"   # the deliberate break
bpy.ops.wm.save_as_mainfile(filepath=sys.argv[1], compress=True)
PY
  set +e
  python tools/build_assets.py --from-blend --only track --blend-dir "$TMP/blend" --out "$TMP/bad" >"$TMP/bad.log" 2>&1
  RC=$?
  set -e
  [ "$RC" -eq 2 ] || { cat "$TMP/bad.log"; fail "expected exit code 2 for the broken .blend, got $RC"; }
  grep -q "CONTRACT ERROR: missing object TRACK_CENTERLINE" "$TMP/bad.log" || { cat "$TMP/bad.log"; fail "error did not name TRACK_CENTERLINE"; }
  [ ! -f "$TMP/bad/track.glb" ] || fail "a broken .blend must not produce a track.glb"
  pass "renamed TRACK_CENTERLINE -> exit 2, '$(grep -o 'CONTRACT ERROR.*' "$TMP/bad.log")'"

  step "G3c (negative): validate_glb rejects a kart file offered as a track"
  set +e
  python tools/validate_glb.py assets/karts/ember.glb >"$TMP/vg.log" 2>&1
  RC=$?
  set -e
  [ "$RC" -eq 1 ] && grep -q "missing object TRACK_SURFACE" "$TMP/vg.log" || { cat "$TMP/vg.log"; fail "validate_glb accepted a non-track"; }
  pass "validate_glb names the missing object"
else
  step "G3: skipped (--no-blender)"
fi

step "G4: GitHub Pages workflow validates (dry run)"
node tools/validate_workflow.js .github/workflows/pages.yml
pass "workflow"

step "G4 (negative): a workflow without deploy-pages is rejected"
WTMP="$(mktemp -d)"
sed '/deploy-pages/d' .github/workflows/pages.yml > "$WTMP/broken.yml"
if node tools/validate_workflow.js "$WTMP/broken.yml" >"$WTMP/w.log" 2>&1; then cat "$WTMP/w.log"; fail "validator accepted a workflow with no deploy-pages step"; fi
grep -q "deploy-pages" "$WTMP/w.log" || { cat "$WTMP/w.log"; fail "validator did not name the missing step"; }
rm -rf "$WTMP"
pass "broken workflow rejected by name"

step "G2: Playwright smoke against the source tree"
npx playwright test
pass "smoke (source)"

step "G4: assemble dist/ exactly as the Pages workflow does, smoke it from a static server"
bash tools/assemble_dist.sh
SERVE_ROOT=dist PORT=4180 npx playwright test tests/smoke.spec.js -g "smoke:"
pass "smoke (dist)"

printf '\n\033[1;32mALL GATES GREEN\033[0m\n'
