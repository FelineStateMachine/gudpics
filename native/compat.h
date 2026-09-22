// Portable math support for the darktable extraction.
// SPDX-License-Identifier: AGPL-3.0-or-later
#include <assert.h>
#include <float.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define DT_ALIGNED_PIXEL
#define DT_ALIGNED_ARRAY
#define DT_OMP_FOR()
#define TRUE 1
#define FALSE 0
#define MIN(a,b) ((a)<(b)?(a):(b))
#define MAX(a,b) ((a)>(b)?(a):(b))
#define CLAMP(x,a,b) MIN(MAX((x),(a)),(b))
#define dt_isnan isnan
#define dt_fast_hypotf hypotf
typedef int gboolean;
static double deg2rad(double x) { return x * M_PI / 180.0; }
static float deg2radf(float x) { return x * (float)M_PI / 180.0f; }
static float rad2degf(float x) { return x * 180.0f / (float)M_PI; }
static void mat3mul(float *out, const float *a, const float *b) {
  float t[9] = {0};
  for(int i=0;i<3;i++) for(int j=0;j<3;j++) for(int k=0;k<3;k++) t[i*3+j] += a[i*3+k]*b[k*3+j];
  memcpy(out,t,sizeof(t));
}
static void mat3mulv(float *out, const float *a, const float *b) {
  for(int i=0;i<3;i++) out[i]=a[i*3]*b[0]+a[i*3+1]*b[1]+a[i*3+2]*b[2];
}
static int mat3inv(float *o, const float *m) {
  const float d=m[0]*(m[4]*m[8]-m[5]*m[7])-m[1]*(m[3]*m[8]-m[5]*m[6])+m[2]*(m[3]*m[7]-m[4]*m[6]);
  if(fabsf(d)<1e-15f) return 1;
  float t[9]={m[4]*m[8]-m[5]*m[7],m[2]*m[7]-m[1]*m[8],m[1]*m[5]-m[2]*m[4],
    m[5]*m[6]-m[3]*m[8],m[0]*m[8]-m[2]*m[6],m[2]*m[3]-m[0]*m[5],
    m[3]*m[7]-m[4]*m[6],m[1]*m[6]-m[0]*m[7],m[0]*m[4]-m[1]*m[3]};
  for(int i=0;i<9;i++) o[i]=t[i]/d;
  return 0;
}
