// SPDX-License-Identifier: AGPL-3.0-or-later
// Thin C ABI over LibRaw for the browser: open a RAF from memory, develop to 8-bit RGB.
#include "libraw/libraw.h"
#include <cstring>
extern "C" {
static LibRaw* lr = nullptr;
static libraw_processed_image_t* img = nullptr;
static void reset_img(){ if(img){ LibRaw::dcraw_clear_mem(img); img=nullptr; } }
int raw_open(const void* buf, size_t len){
  reset_img(); if(lr){ lr->recycle(); } else lr = new LibRaw();
  return lr->open_buffer(const_cast<void*>(buf), len);
}
const char* raw_make(){ return lr ? lr->imgdata.idata.make : ""; }
const char* raw_model(){ return lr ? lr->imgdata.idata.model : ""; }
int raw_width(){ return lr ? lr->imgdata.sizes.width : 0; }
int raw_height(){ return lr ? lr->imgdata.sizes.height : 0; }
int raw_film_mode(){ return lr ? (int)lr->imgdata.makernotes.fuji.FilmMode : 0; }
int raw_is_xtrans(){ return lr ? (lr->imgdata.idata.filters == 9) : 0; }
int raw_dev_dr(){ return lr ? (int)lr->imgdata.makernotes.fuji.DevelopmentDynamicRange : 0; }
int raw_auto_dr(){ return lr ? (int)lr->imgdata.makernotes.fuji.AutoDynamicRange : 0; }
int raw_dr_setting(){ return lr ? (int)lr->imgdata.makernotes.fuji.DynamicRangeSetting : 0; }
// gamma: 0 = linear, 1 = sRGB curve. color: 1 sRGB, 8 Rec2020. half: 1 = half size.
int raw_develop(int half, int gamma, int color, int bps){
  if(!lr) return -1; reset_img();
  libraw_output_params_t& p = lr->imgdata.params;
  p.half_size = half; p.use_camera_wb = 1; p.use_auto_wb = 0; p.output_color = color; p.output_bps = bps;
  p.no_auto_bright = 1; p.highlight = 0; p.user_qual = half ? 0 : 1; p.fbdd_noiserd = 0; p.med_passes = 0;
  if(gamma){ p.gamm[0] = 1.0/2.4; p.gamm[1] = 12.92; } else { p.gamm[0] = 1; p.gamm[1] = 1; }
  int r = lr->unpack(); if(r) return r;
  r = lr->dcraw_process(); if(r) return r;
  int err = 0; img = lr->dcraw_make_mem_image(&err); return err;
}
unsigned char* raw_data(){ return img ? img->data : nullptr; }
int raw_out_width(){ return img ? img->width : 0; }
int raw_out_height(){ return img ? img->height : 0; }
int raw_out_bits(){ return img ? img->bits : 0; }
unsigned raw_out_size(){ return img ? img->data_size : 0; }
void raw_free(){ reset_img(); if(lr){ delete lr; lr=nullptr; } }
}
