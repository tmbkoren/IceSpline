#!/usr/bin/env bash
set -euo pipefail
mkdir -p public
emcc wasm/curve.cpp -O2 \
  -s EXPORT_ES6=1 -s MODULARIZE=1 \
  -s EXPORTED_FUNCTIONS='["_compute_blocks","_compute_segment_blocks","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF64","HEAP32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -o public/curve.js
echo "Built public/curve.js + public/curve.wasm"
