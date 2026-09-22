// SPDX-License-Identifier: AGPL-3.0-or-later
// Error level analysis: re-encode the picture as JPEG at a chosen quality and amplify the difference.
let w=0,h=0,original=null,diff=null,diffQuality=-1;
async function load(bitmap){
  w=bitmap.width;h=bitmap.height;
  const c=new OffscreenCanvas(w,h),x=c.getContext('2d',{willReadFrequently:true});x.drawImage(bitmap,0,0);bitmap.close();
  original=x.getImageData(0,0,w,h).data;diff=null;diffQuality=-1;
  return {w,h};
}
async function computeDiff(quality){
  if(diffQuality===quality&&diff)return;
  const c=new OffscreenCanvas(w,h),x=c.getContext('2d',{willReadFrequently:true});
  x.putImageData(new ImageData(original,w,h),0,0);
  const blob=await c.convertToBlob({type:'image/jpeg',quality:quality/100});
  const bmp=await createImageBitmap(blob);x.drawImage(bmp,0,0);bmp.close();
  const re=x.getImageData(0,0,w,h).data,d=new Uint8Array(w*h*3);
  for(let i=0,o=0;i<re.length;i+=4,o+=3){d[o]=Math.abs(original[i]-re[i]);d[o+1]=Math.abs(original[i+1]-re[i+1]);d[o+2]=Math.abs(original[i+2]-re[i+2]);}
  diff=d;diffQuality=quality;
}
function amplify(scale){
  const out=new Uint8ClampedArray(w*h*4);
  for(let i=0,o=0;i<diff.length;i+=3,o+=4){out[o]=diff[i]*scale;out[o+1]=diff[i+1]*scale;out[o+2]=diff[i+2]*scale;out[o+3]=255;}
  return out;
}
self.onmessage=async({data})=>{
  try{
    let result,transfer=[];
    if(data.type==='load')result=await load(data.bitmap);
    else if(data.type==='render'){if(!original)throw Error('Open a photo first.');await computeDiff(data.quality);const px=amplify(data.scale);result={w,h,data:px};transfer=[px.buffer];}
    else if(data.type==='close'){original=diff=null;result={ok:true};}
    else throw Error('Unknown operation.');
    self.postMessage({id:data.id,result},transfer);
  }catch(e){self.postMessage({id:data.id,error:e.message||'Analysis failed.'});}
};
