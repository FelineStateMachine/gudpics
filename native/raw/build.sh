#!/bin/sh
# Build LibRaw plus the wrapper to assets/raw.mjs and assets/raw.wasm. Requires Emscripten.
# LibRaw is LGPL-2.1 (or CDDL-1.0), unmodified; see NOTICE.md for the pinned revision.
set -eu
cd "$(dirname "$0")/../.."
LIBRAW=${LIBRAW:-native/upstream/LibRaw}
SRCS=$(find "$LIBRAW/src" -name '*.cpp' | grep -v -E 'libraw_c_api|_ph\.cpp')
em++ -O3 -std=c++11 -DLIBRAW_NOTHREADS -DUSE_X3FTOOLS=0 -I"$LIBRAW" $SRCS native/raw/wrapper.cpp \
  -o assets/raw.mjs \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=1073741824 -sSTACK_SIZE=4194304 -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_raw_open","_raw_make","_raw_model","_raw_width","_raw_height","_raw_film_mode","_raw_is_xtrans","_raw_dev_dr","_raw_auto_dr","_raw_dr_setting","_raw_develop","_raw_data","_raw_out_width","_raw_out_height","_raw_out_bits","_raw_out_size","_raw_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU16","UTF8ToString"]' \
  -fwasm-exceptions
