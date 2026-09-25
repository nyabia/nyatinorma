// SPDX-License-Identifier: MIT OR Apache-2.0
import sharp from 'sharp';
import type {Box,VisualAnchor} from './types.js';
import {rename} from 'node:fs/promises';

// ScreenCaptureKit may put a 1x window in a larger transparent output buffer.
// Use alpha (never black game pixels) to recover the window's coordinate space.
export async function normalizeCapture(path:string,frame:Box) {
  const {data,info}=await sharp(path).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let right=-1,bottom=-1,left=info.width,top=info.height;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
    if(data[(y*info.width+x)*info.channels+info.channels-1]!==0){
      right=Math.max(right,x);bottom=Math.max(bottom,y);left=Math.min(left,x);top=Math.min(top,y);
    }
  }
  if(right<0)throw new Error('Captured window is fully transparent; observe again.');
  const width=right+1,height=bottom+1;
  if(width===info.width&&height===info.height)return {width,height};
  if(left!==0||top!==0||Math.abs(width/frame.width-height/frame.height)>.005)
    throw new Error('Capture content does not align with the game window; input is disabled.');
  const bytes=await sharp(path).extract({left:0,top:0,width,height}).png().toBuffer();
  await sharp(bytes).toFile(path+'.normalized.png');await rename(path+'.normalized.png',path);
  return {width,height};
}
export function validateBox(b:Box) {
  if (![b.x,b.y,b.width,b.height].every(Number.isFinite) || b.x<0 || b.y<0 || b.width<=0 || b.height<=0 || b.x+b.width>1.000001 || b.y+b.height>1.000001) throw new Error(`Box must be inside the FULL window in normalized 0–1 coordinates: x+width=${b.x+b.width}, y+height=${b.y+b.height}; both must be <=1. Received ${JSON.stringify(b)}. Re-observe and correct the box; nothing was clicked.`);
}
// Viewing can clip an oversized crop; action boxes must still pass validateBox unchanged.
export function observationBox(b:Box):Box {
  if(![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.x<0||b.y<0||b.x>=1||b.y>=1||b.width<=0||b.height<=0)throw new Error('Observation crop must overlap the full window.');
  return {...b,width:Math.min(b.width,1-b.x),height:Math.min(b.height,1-b.y)};
}
// Keep the requested point at the exact centre. Only the verification patch
// shrinks near an edge; the click itself is never clamped or moved inward.
export function pointBox(point:{x:number;y:number},width:number,height:number):Box {
  if(![point.x,point.y,width,height].every(Number.isFinite)||point.x<=0||point.x>=1||point.y<=0||point.y>=1||width<=0||height<=0)throw new Error('Point must be strictly inside the FULL window in normalized 0–1 coordinates.');
  const dx=Math.min(8/width,point.x,1-point.x),dy=Math.min(8/height,point.y,1-point.y);
  return {x:point.x-dx,y:point.y-dy,width:dx*2,height:dy*2};
}
export async function crop(path:string,b:Box,width=1000):Promise<Buffer> {
  validateBox(b); const m = await sharp(path).metadata();
  const left=Math.floor(b.x*m.width!), top=Math.floor(b.y*m.height!);
  return sharp(path).extract({left,top,width:Math.max(1,Math.min(m.width!-left,Math.round(b.width*m.width!))),height:Math.max(1,Math.min(m.height!-top,Math.round(b.height*m.height!)))})
    .resize({width,withoutEnlargement:false}).png().toBuffer();
}
export async function fingerprint(path:string,b:Box):Promise<string> {
  const bytes=await crop(path,b,96);
  return (await sharp(bytes).resize(32,24,{fit:'fill'}).greyscale().raw().toBuffer()).toString('base64');
}
export function difference(a:string,b:string) {
  const x=Buffer.from(a,'base64'),y=Buffer.from(b,'base64');
  if (x.length!==y.length || !x.length) return 1;
  let sum=0; for(let i=0;i<x.length;i++) sum+=Math.abs(x[i]-y[i]); return sum/(255*x.length);
}
export async function validateVisualAnchors(anchors:VisualAnchor[],path:string,maxError:number) {
  if(!anchors.length)throw new Error('Missing visual screen anchors');
  for(const [index,anchor] of anchors.entries()){
    validateBox(anchor.box);
    const pixels=Buffer.from(anchor.template,'base64');
    if(pixels.length!==768)throw new Error('Invalid visual anchor template');
    const mean=pixels.reduce((a,b)=>a+b,0)/pixels.length;
    const variance=pixels.reduce((a,b)=>a+(b-mean)**2,0)/pixels.length;
    if(Math.sqrt(variance)<12)throw new Error('Visual anchor is too uniform; choose a distinct header, selected tab, or popup frame');
    const delta=difference(anchor.template,await fingerprint(path,anchor.box));
    if(delta>maxError)throw new Error(`Visual screen region ${index+1} changed (${delta.toFixed(3)} > ${maxError}); box=${JSON.stringify(anchor.box)}. Re-observe and choose a stable header/tab, excluding animated artwork or moving buttons.`);
  }
}
export async function matchTarget(path:string,target:Box,template:string,width:number,height:number) {
  // Allow only two pixels of rendering jitter, not semantic retargeting.
  // Larger movement returns to the model for a new crop and definition.
  const matches=await Promise.all([0,-2,2].flatMap(dx=>[0,-2,2].map(async dy=>{
    const box={...target,x:target.x+dx/width,y:target.y+dy/height};
    try{validateBox(box);}catch{return {box,delta:Infinity};}
    return {box,delta:difference(template,await fingerprint(path,box))};
  })));
  return matches.sort((a,b)=>a.delta-b.delta)[0];
}
export function fromCrop(point:{x:number;y:number},view:Box):{x:number;y:number} {
  return {x:view.x+point.x*view.width,y:view.y+point.y*view.height};
}
export function gridRegion(path:string[]):Box {
  if(path.length>4)throw new Error('Use at most four zoom levels');
  let box={x:0,y:0,width:1,height:1};
  for(const cell of path){
    if(!/^[A-D][1-4]$/.test(cell))throw new Error('Grid cell must be A1–D4; rows A–D top to bottom, columns 1–4 left to right');
    const width=box.width/4,height=box.height/4;
    box={x:box.x+(Number(cell[1])-1)*width,y:box.y+(cell.charCodeAt(0)-65)*height,width,height};
  }
  return box;
}
export async function gridOverlay(bytes:Buffer):Promise<Buffer> {
  const {width:w,height:h}=await sharp(bytes).metadata();
  const width=w!,height=h!,size=Math.max(12,Math.min(22,width/32));
  const labels=Array.from({length:16},(_,i)=>{
    const x=(i%4)*width/4,y=Math.floor(i/4)*height/4;
    return `<rect x="${x}" y="${y}" width="${width/4}" height="${height/4}" fill="none" stroke="#00ffff" stroke-width="1"/><rect x="${x+1}" y="${y+1}" width="${size*1.7}" height="${size+5}" fill="#000" fill-opacity=".8"/><text x="${x+3}" y="${y+size}" fill="#fff" font-size="${size}" font-family="sans-serif">${String.fromCharCode(65+Math.floor(i/4))}${i%4+1}</text>`;
  }).join('');
  return sharp(bytes).composite([{input:Buffer.from(`<svg width="${width}" height="${height}">${labels}</svg>`)}]).png().toBuffer();
}
