#!/usr/bin/env bash
# Assemble the static site into dist/ with no bundler: page, modules, assets,
# and only the files the import map in index.html points at.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist/node_modules/three/build dist/node_modules/three/examples/jsm/loaders dist/node_modules/three/examples/jsm/utils
cp index.html dist/
cp -r src assets dist/
cp node_modules/three/build/three.module.js node_modules/three/build/three.core.js dist/node_modules/three/build/
# Only the addons the render layer imports, plus their transitive relative imports
# (GLTFLoader -> BufferGeometryUtils, SkeletonUtils). verify.sh smokes dist/ to catch drift.
for f in loaders/GLTFLoader.js utils/BufferGeometryUtils.js utils/SkeletonUtils.js; do
  cp "node_modules/three/examples/jsm/$f" "dist/node_modules/three/examples/jsm/$f"
done
touch dist/.nojekyll
echo "dist/: $(find dist -type f | wc -l) files, $(du -sh dist | cut -f1)"
