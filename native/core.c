// Upright browser adapter, 2026-09-21. SPDX-License-Identifier: AGPL-3.0-or-later
// The included extraction retains darktable's and LSD's original notices.
#include "extracted.inc"
static dt_iop_ashift_gui_data_t state;
static dt_iop_module_t module = { &state };
static float result[13]; // angle, vertical shift, horizontal shift, shear, 3x3 forward matrix
static float *flat_lines;

int detect(const uint8_t *rgba, int w, int h) {
  if(w<2 || h<2 || w>1200 || h>1200) return -1;
  free(state.lines); state.lines=NULL; free(flat_lines); flat_lines=NULL;
  memset(&state,0,sizeof(state));
  state.lines_in_width=w; state.lines_in_height=h;
  state.rotation_range=ROTATION_RANGE; state.lensshift_v_range=LENSSHIFT_RANGE;
  state.lensshift_h_range=LENSSHIFT_RANGE; state.shear_range=SHEAR_RANGE;
  float *pixels=malloc((size_t)w*h*4*sizeof(float));
  if(!pixels) return -1;
  for(size_t i=0;i<(size_t)w*h*4;i++) pixels[i]=rgba[i]/255.0f;
  line_detect(pixels,w,h,0,0,1,&state.lines,&state.lines_count,
    &state.vertical_count,&state.horizontal_count,&state.vertical_weight,&state.horizontal_weight,0,FALSE);
  free(pixels);
  srand(42); // Repeatable results for repeated previews of the same photo.
  if(!_remove_outliers(&module)) return -1;
  flat_lines=malloc(MAX(1,state.lines_count)*6*sizeof(float));
  return flat_lines ? state.lines_count : -1;
}

float *lines(void) {
  if(!flat_lines) return NULL;
  for(int i=0;i<state.lines_count;i++) {
    const dt_iop_ashift_line_t *l=&state.lines[i];
    flat_lines[i*6]=l->p1[0]; flat_lines[i*6+1]=l->p1[1];
    flat_lines[i*6+2]=l->p2[0]; flat_lines[i*6+3]=l->p2[1];
    flat_lines[i*6+4]=l->type; flat_lines[i*6+5]=l->weight;
  }
  return flat_lines;
}

int fit(int mode) {
  dt_iop_ashift_params_t p={0}; p.mode=ASHIFT_MODE_GENERIC;
  int dir=mode==1?ASHIFT_FIT_VERTICALLY:mode==2?ASHIFT_FIT_HORIZONTALLY:
    mode==3?ASHIFT_FIT_BOTH_SHEAR:ASHIFT_FIT_ROTATION_BOTH_LINES;
  int status=nmsfit(&module,&p,dir);
  if(status) return status;
  if(!isfinite(p.rotation)||!isfinite(p.lensshift_v)||!isfinite(p.lensshift_h)||!isfinite(p.shear)) return NMS_INSANE;
  result[0]=p.rotation; result[1]=p.lensshift_v; result[2]=p.lensshift_h; result[3]=p.shear;
  return 0;
}

float *matrix(int w,int h,float angle,float vertical,float horizontal,float shear) {
  result[0]=angle;result[1]=vertical;result[2]=horizontal;result[3]=shear;
  _homography(result+4,angle,vertical,horizontal,shear,DEFAULT_F_LENGTH,0,1,w,h,ASHIFT_HOMOGRAPH_FORWARD);
  return result;
}
float *parameters(void) { return result; }

// Inverse-mapped bilinear browser renderer; independent of darktable's pixelpipe.
int warp(const uint8_t *src,int w,int h,uint8_t *dst,int ow,int oh,const float *inv,
  float left,float top,float cw,float ch) {
  if(w<2||h<2||ow<1||oh<1) return 1;
  for(int y=0;y<oh;y++) for(int x=0;x<ow;x++) {
    const float u=left+(x+0.5f)*cw/ow, v=top+(y+0.5f)*ch/oh;
    const float z=inv[6]*u+inv[7]*v+inv[8];
    const float sx=(inv[0]*u+inv[1]*v+inv[2])/z, sy=(inv[3]*u+inv[4]*v+inv[5])/z;
    uint8_t *o=dst+4*((size_t)y*ow+x);
    if(!isfinite(sx)||!isfinite(sy)||sx<0||sy<0||sx>w-1||sy>h-1) {
      o[0]=o[1]=o[2]=245; o[3]=255; continue;
    }
    int ix=MIN((int)sx,w-2), iy=MIN((int)sy,h-2);
    float fx=sx-ix,fy=sy-iy;
    const uint8_t *p=src+4*((size_t)iy*w+ix);
    for(int c=0;c<3;c++) o[c]=(uint8_t)CLAMP((1-fy)*((1-fx)*p[c]+fx*p[4+c])+fy*((1-fx)*p[w*4+c]+fx*p[w*4+4+c])+0.5f,0,255);
    o[3]=255;
  }
  return 0;
}
