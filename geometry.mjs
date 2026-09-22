// SPDX-License-Identifier: AGPL-3.0-or-later
export function project(m, x, y) {
  const z=m[6]*x+m[7]*y+m[8];
  if(!Number.isFinite(z)||z<=1e-6) throw Error('This correction folds the image. Reduce the strength.');
  return [(m[0]*x+m[1]*y+m[2])/z,(m[3]*x+m[4]*y+m[5])/z];
}
export function inverse(m) {
  const [a,b,c,d,e,f,g,h,i]=m;
  const det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  if(!Number.isFinite(det)||Math.abs(det)<1e-12) throw Error('The correction is too extreme.');
  return [e*i-f*h,c*h-b*i,b*f-c*e,f*g-d*i,a*i-c*g,c*d-a*f,d*h-e*g,b*g-a*h,a*e-b*d].map(v=>v/det);
}
// Conservative scan of a convex projected image. Rows use the intersection
// at both ends, so every point of the returned rectangle is inside the polygon.
// This is a new browser crop implementation, not darktable's crop optimizer.
export function cropRect(m,w,h,mode='largest') {
  const q=[[1,1],[w-2,1],[w-2,h-2],[1,h-2]].map(p=>project(m,...p));
  const xs=q.map(p=>p[0]),ys=q.map(p=>p[1]);
  const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
  if(![left,right,top,bottom].every(Number.isFinite)||(right-left)*(bottom-top)>w*h*5) throw Error('This correction stretches the image too far.');
  if(mode==='none') return {x:left,y:top,w:right-left,h:bottom-top};
  const interval=y=>{
    const values=[];
    for(let i=0;i<4;i++) {
      const a=q[i],b=q[(i+1)%4];
      if(Math.abs(a[1]-b[1])<1e-8) { if(Math.abs(y-a[1])<1e-6) values.push(a[0],b[0]); }
      else if(y>=Math.min(a[1],b[1])-1e-6&&y<=Math.max(a[1],b[1])+1e-6)
        values.push(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]));
    }
    return values.length?[Math.min(...values),Math.max(...values)]:[Infinity,-Infinity];
  };
  const n=256,dy=(bottom-top)/n,rows=[];
  for(let i=0;i<n;i++) {
    const a=interval(top+i*dy),b=interval(top+(i+1)*dy);
    rows.push([Math.max(a[0],b[0]),Math.min(a[1],b[1])]);
  }
  let best=null,area=0;
  for(let i=0;i<n;i++) {
    let l=-Infinity,r=Infinity;
    for(let j=i;j<n;j++) {
      l=Math.max(l,rows[j][0]); r=Math.min(r,rows[j][1]);
      if(r<=l) break;
      let cw=r-l,ch=(j-i+1)*dy;
      if(mode==='original') {cw=Math.min(cw,ch*w/h);ch=cw*h/w;}
      if(cw*ch>area) {area=cw*ch;best={x:(l+r-cw)/2,y:top+i*dy+((j-i+1)*dy-ch)/2,w:cw,h:ch};}
    }
  }
  if(!best||area<w*h*.08) throw Error('Too little image remains. Try a gentler correction.');
  return best;
}
