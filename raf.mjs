// SPDX-License-Identifier: AGPL-3.0-or-later
// Fujifilm RAF container: extract the embedded in-camera JPEG and read what the camera applied.
const MAGIC='FUJIFILMCCD-RAW ';
export function parseRaf(buffer){
  const bytes=new Uint8Array(buffer),view=new DataView(buffer);
  if(bytes.length<112||String.fromCharCode(...bytes.subarray(0,16))!==MAGIC)throw Error('Not a Fujifilm RAF file.');
  const model=String.fromCharCode(...bytes.subarray(28,60)).replace(/\0+$/,'').trim();
  const offset=view.getUint32(84),length=view.getUint32(88);
  if(offset+length>bytes.length||length<4||bytes[offset]!==0xFF||bytes[offset+1]!==0xD8)throw Error('No embedded JPEG found in this RAF.');
  const jpeg=bytes.slice(offset,offset+length);
  return {model,jpeg,...readExif(jpeg)};
}
// Fuji makernote tags (as documented by ExifTool).
const FILM={0:'Provia',0x100:'Studio Portrait',0x110:'Studio Portrait Enhanced',0x120:'Astia',0x130:'Studio Portrait Sharp',0x200:'Velvia',0x300:'Studio Portrait Ex',0x400:'Velvia',0x500:'Pro Neg. Std',0x501:'Pro Neg. Hi',0x600:'Classic Chrome',0x700:'Eterna',0x800:'Classic Neg.',0x900:'Eterna Bleach Bypass',0xa00:'Nostalgic Neg.',0xb00:'Reala Ace'};
const MONO={0x300:'Monochrome',0x301:'Monochrome+R',0x302:'Monochrome+Ye',0x303:'Monochrome+G',0x310:'Sepia',0x500:'Acros',0x501:'Acros+R',0x502:'Acros+Ye',0x503:'Acros+G'};
function readExif(jpeg){
  const out={simulation:'',camera:'',width:0,height:0,date:''};
  try{
    const v=new DataView(jpeg.buffer,jpeg.byteOffset,jpeg.byteLength);
    let p=2;
    while(p+4<=jpeg.length&&jpeg[p]===0xFF){
      const marker=jpeg[p+1],len=v.getUint16(p+2);
      if(marker===0xE1&&String.fromCharCode(...jpeg.subarray(p+4,p+10))==='Exif\0\0'){parseTiff(jpeg.subarray(p+10,p+2+len),out);}
      if(marker>=0xC0&&marker<=0xC3){out.height=v.getUint16(p+5);out.width=v.getUint16(p+7);}
      if(marker===0xDA)break;
      p+=2+len;
    }
  }catch{}
  return out;
}
function parseTiff(t,out){
  const v=new DataView(t.buffer,t.byteOffset,t.byteLength),le=t[0]===0x49;
  const u16=o=>v.getUint16(o,le),u32=o=>v.getUint32(o,le);
  const str=(o,n)=>String.fromCharCode(...t.subarray(o,o+n)).replace(/\0+$/,'').trim();
  const ifd=(o,cb)=>{const n=u16(o);for(let i=0;i<n;i++){const e=o+2+i*12,tag=u16(e),type=u16(e+2),count=u32(e+4);const size=[0,1,1,2,4,8,1,1,2,4,8,4,8][type]*count;const val=size<=4?e+8:u32(e+8);cb(tag,type,count,val);}};
  let exifOffset=0;
  ifd(u32(4),(tag,type,count,val)=>{if(tag===0x110)out.camera=str(val,count);if(tag===0x8769)exifOffset=u32(val);});
  if(!exifOffset)return;
  let maker=0,makerLen=0;
  ifd(exifOffset,(tag,type,count,val)=>{if(tag===0x927c){maker=val;makerLen=count;}if(tag===0x9003)out.date=str(val,count);});
  if(!maker||str(maker,8)!=='FUJIFILM')return;
  // Fuji makernote: 8 byte signature, 4 byte IFD offset relative to the makernote start, little endian.
  const m=new DataView(t.buffer,t.byteOffset+maker,makerLen);
  const mo=m.getUint32(8,true),n=m.getUint16(mo,true);
  let film=0,mono=-1;
  for(let i=0;i<n;i++){const e=mo+2+i*12,tag=m.getUint16(e,true),type=m.getUint16(e+2,true);const val=type===3?m.getUint16(e+8,true):m.getUint32(e+8,true);if(tag===0x1401)film=val;if(tag===0x1003)mono=val;}
  out.simulation=MONO[mono]||FILM[film]||'';
}
