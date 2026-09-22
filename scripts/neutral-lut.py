"""Generate the neutral LUTs in assets/luts/neutral-dr*.png.
SPDX-License-Identifier: AGPL-3.0-or-later

A Hald image in the LibRaw output domain (sRGB-encoded, camera white balance, sRGB primaries)
is wrapped as a LinearRaw DNG carrying an X-Pro3 color matrix and as-shot neutral, then rendered
through darktable-cli with the default scene-referred (filmic) workflow. The result is the mapping
from LibRaw's render to darktable's default render, which is the input the film simulation LUTs
in assets/luts were fitted against. One LUT per Fujifilm DR mode, since darktable compensates
DR200 and DR400 by one and two stops. Requires darktable-cli, numpy and Pillow.
"""
import numpy as np, struct, subprocess, sys
N=33; BLOCK=4
cam_xyz=[1.3426,-0.6334,-0.1177,-0.4244,1.2136,0.2371,-0.058,0.1303,0.598]
rgb_cam=np.array([[1.23842,0.0314905,-0.269914],[-0.146979,1.55701,-0.410031],[0.00372626,-0.395365,1.39164]])
cam_mul=np.array([567.,302.,545.]); wb=cam_mul/cam_mul.min()
neutral=[302/567,1.0,302/545]
def srgb_decode(u): return np.where(u<=0.04045,u/12.92,((u+0.055)/1.055)**2.4)
def write_cam_dng(path,rgb16,white=65535):
    h,w,_=rgb16.shape; data=rgb16.astype('<u2').tobytes(); entries=[]
    def add(tag,typ,vals):
        if typ==2: b=vals.encode()+b'\0'; cnt=len(b)
        elif typ==3: b=struct.pack('<%dH'%len(vals),*vals); cnt=len(vals)
        elif typ==4: b=struct.pack('<%dI'%len(vals),*vals); cnt=len(vals)
        elif typ==1: b=bytes(vals); cnt=len(vals)
        elif typ==5: b=b''.join(struct.pack('<II',n,d) for n,d in vals); cnt=len(vals)
        elif typ==10: b=b''.join(struct.pack('<ii',n,d) for n,d in vals); cnt=len(vals)
        entries.append((tag,typ,cnt,b))
    add(254,4,[0]); add(256,4,[w]); add(257,4,[h]); add(258,3,[16,16,16]); add(259,3,[1]); add(262,3,[34892])
    add(271,2,'FUJIFILM'); add(272,2,'X-Pro3'); add(273,4,[0]); add(274,3,[1]); add(277,3,[3]); add(278,4,[h]); add(279,4,[len(data)]); add(284,3,[1])
    add(50706,1,[1,4,0,0]); add(50707,1,[1,1,0,0]); add(50708,2,'FUJIFILM X-Pro3'); add(50714,4,[0,0,0]); add(50717,4,[white,white,white])
    add(50721,10,[(int(round(v*1e6)),1000000) for v in cam_xyz]); add(50728,5,[(int(round(n*1e6)),1000000) for n in neutral]); add(50778,3,[21])
    entries.sort(key=lambda e:e[0]); n=len(entries); ifd_off=8; extra_off=ifd_off+2+n*12+4; extra=b''; ifd=struct.pack('<H',n)
    for tag,typ,cnt,b in entries:
        if tag==273: ifd+=struct.pack('<HHII',tag,typ,cnt,0); continue
        if len(b)<=4: ifd+=struct.pack('<HHI',tag,typ,cnt)+b.ljust(4,b'\0')
        else: ifd+=struct.pack('<HHII',tag,typ,cnt,extra_off+len(extra)); extra+=b+(b'\0' if len(b)%2 else b'')
    ifd+=struct.pack('<I',0); data_off=extra_off+len(extra)
    idx=[e[0] for e in entries].index(273); pos=2+idx*12+8; ifd=ifd[:pos]+struct.pack('<I',data_off)+ifd[pos+4:]
    open(path,'wb').write(b'II*\0'+struct.pack('<I',ifd_off)+ifd+extra+data)
def hald_linear():
    g=np.arange(N)/(N-1)
    b,gg,r=np.meshgrid(g,g,g,indexing='ij')   # index order [b][g][r], r fastest
    u=np.stack([r,gg,b],axis=-1).reshape(-1,3)  # N^3 x 3 encoded sRGB
    lin=srgb_decode(u)
    cam=lin@np.linalg.inv(rgb_cam).T           # linear sRGB -> camera space (post WB)
    raw=cam/wb                                  # undo white balance
    return raw
def make_dng(gain,path):
    raw=hald_linear()*gain
    raw=np.clip(raw,0,0.995)                    # keep below clipping so highlight reconstruction stays out
    cells=raw.reshape(N*N,N,3)                  # rows = b*N+g, cols = r
    img=np.repeat(np.repeat(cells,BLOCK,axis=0),BLOCK,axis=1)
    write_cam_dng(path,(img*65535+0.5).astype(np.uint16))
    return img.shape
import os
DT=os.environ.get('DARKTABLE_CLI','/Applications/darktable.app/Contents/MacOS/darktable-cli')
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','assets','luts')
TMP='/tmp/gudpics-neutral-lut'; os.makedirs(TMP,exist_ok=True)
for gain,tag in [(1,'dr100'),(2,'dr200'),(4,'dr400')]:
    shape=make_dng(gain,f'{TMP}/hald_{tag}.dng')
    subprocess.run(['rm','-f',f'{TMP}/hald_{tag}.png'])
    r=subprocess.run([DT,f'{TMP}/hald_{tag}.dng',f'{TMP}/hald_{tag}.png','--core','--configdir',TMP+'/dtconf','--conf','plugins/darkroom/workflow=scene-referred (filmic)','--conf','plugins/imageio/format/png/bpp=8'],capture_output=True,text=True)
    print(tag,'dng',shape,'darktable:',[l for l in (r.stdout+r.stderr).splitlines() if 'export' in l or 'rror' in l][-1:])

from PIL import Image
for tag in ['dr100','dr200','dr400']:
    im=np.asarray(Image.open(f'{TMP}/hald_{tag}.png').convert('RGB'),dtype=np.float32)
    cells=im.reshape(N*N,BLOCK,N,BLOCK,3)[:,1:3,:,1:3,:].mean(axis=(1,3))  # inner pixels of each block
    Image.fromarray(np.clip(cells+0.5,0,255).astype(np.uint8)).save(os.path.join(OUT,f'neutral-{tag}.png'))
    print('wrote',f'neutral-{tag}.png',cells.shape)
