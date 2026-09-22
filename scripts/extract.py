"""Reproducible extraction from the vendored, pinned darktable source.
Run from any directory. No network required. Changes documented in NOTICE.md.
SPDX-License-Identifier: AGPL-3.0-or-later
"""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src = (root / 'native/upstream/ashift.c').read_text()

def section(start, end):
    return src[src.index(start):src.index(end, src.index(start))]

parts = [src[:src.index('#include')],
         '// Extracted and adapted for Upright, 2026-09-21. See NOTICE.md.\n',
         '#include "compat.h"\n',
         section('#define ROTATION_RANGE ', '// For line detection'),
         '#include "lsd.inc"\n#include "upstream/ashift_nmsimplex.c"\n',
         section('typedef enum dt_iop_ashift_method_t', 'typedef struct dt_iop_ashift_cropfit_params_t'),
         '''typedef struct {
  dt_iop_ashift_line_t *lines;
  int lines_count, lines_in_width, lines_in_height, lines_x_off, lines_y_off;
  int vertical_count, horizontal_count, lines_version, isflipped;
  float vertical_weight, horizontal_weight;
  float rotation_range, lensshift_v_range, lensshift_h_range, shear_range;
} dt_iop_ashift_gui_data_t;
typedef struct { dt_iop_ashift_gui_data_t *gui_data; } dt_iop_module_t;
''',
         section('// normalized product of two 3x1 vectors', 'static inline void _shadow_crop_box'),
         section('#define MAT3SWAP', '// check if module parameters'),
         section('static void rgb2grey256', '// sobel edge enhancement')]
detect = section('static gboolean line_detect(', '// get image from buffer')
start = detect.index('  // apply gamma correction')
end = detect.index('  // allocate intermediate buffers')
detect = detect[:start] + '  // Browser input is already display-referred; no RAW/detail preprocessing.\n' + detect[end:]
start = detect.index('  // if requested perform an additional edge')
end = detect.index('  // call the line segment detector')
detect = detect[:start] + detect[end:]
parts.append(detect)
fitting = section('static inline void swap(', '#ifdef ASHIFT_DEBUG\n// only used in development')
# Preserve one/two-line selections when RANSAC is deliberately skipped.
fitting = fitting.replace('inout_set[vnb] = 0;', 'inout_set[vnb] = 1;').replace('inout_set[hnb] = 0;', 'inout_set[hnb] = 1;')
parts.append(fitting)
(root / 'native/extracted.inc').write_text('\n'.join(parts))
lsd = (root / 'native/upstream/ashift_lsd.c').read_text()
lsd = lsd.replace('#include "common/math.h"', '// math helpers supplied by compat.h')
lsd = lsd.replace('dt_print(DT_DEBUG_ALWAYS,"LSD Error: %s",msg);', 'fprintf(stderr,"LSD Error: %s\\n",msg);')
(root / 'native/lsd.inc').write_text(lsd)
print('Extracted detector, classification, RANSAC, fit and homography.')
