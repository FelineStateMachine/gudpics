#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 scripts/extract.py
emcc native/core.c -O3 -o assets/core.mjs \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=268435456 \
  -sSTACK_SIZE=2097152 -sFILESYSTEM=0 \
  '-sEXPORTED_FUNCTIONS=["_malloc","_free","_detect","_lines","_fit","_matrix","_parameters","_warp"]' \
  '-sEXPORTED_RUNTIME_METHODS=["HEAPU8","HEAPF32"]'
