// SPDX-License-Identifier: MIT OR Apache-2.0
import sharp from 'sharp';
import {fromCrop,gridRegion,pointBox,validateBox} from './vision.js';
import type {GridPoint,TargetCoordinates,DestinationCoordinates,Point,Snapshot,Box} from './types.js';

export function gridPoint(point:GridPoint):Point{
  if(!point.regionPath.length)throw new Error('gridPoint needs at least one grid cell.');
  if(![point.x,point.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw new Error('Grid-local x/y must be between 0 and 1.');
  return fromCrop(point,gridRegion(point.regionPath));
}
export function resolveTarget(input:TargetCoordinates,width:number,height:number){
  if([input.point,input.box,input.regionPath,input.gridPoint].filter(v=>v!==undefined).length!==1)throw new Error('Provide exactly one target: point, box, regionPath or gridPoint.');
  if(input.regionPath&&!input.regionPath.length)throw new Error('A target regionPath requires at least one cell.');
  const point=input.gridPoint?gridPoint(input.gridPoint):input.point;
  const box=point?pointBox(point,width,height):input.regionPath?gridRegion(input.regionPath):input.box!;
  validateBox(box);
  return {box,point:{x:box.x+box.width/2,y:box.y+box.height/2}};
}
export function resolveDestination(input:DestinationCoordinates):Point|undefined{
  if([input.to,input.toRegionPath,input.toGridPoint].filter(v=>v!==undefined).length>1)throw new Error('Provide only one endpoint: to, toRegionPath or toGridPoint.');
  if(input.toRegionPath&&!input.toRegionPath.length)throw new Error('An endpoint regionPath requires at least one cell.');
  const region=input.toRegionPath?gridRegion(input.toRegionPath):undefined;
  const point=input.toGridPoint?gridPoint(input.toGridPoint):region?{x:region.x+region.width/2,y:region.y+region.height/2}:input.to;
  if(point&&![point.x,point.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw new Error('Endpoint must be inside the full window, normalized 0–1.');
  return point;
}

/** Render on an in-memory copy. Never capture, click, change freshness, or edit evidence. */
export async function previewTarget(s:Snapshot,input:TargetCoordinates&DestinationCoordinates){
  const {box,point}=resolveTarget(input,s.width,s.height),to=resolveDestination(input);
  const bytes=await sharp(s.path).png().toBuffer(),meta=await sharp(bytes).metadata();
  if(meta.width!==s.width||meta.height!==s.height)throw new Error('Snapshot dimensions disagree; observe again.');
  const w=s.width,h=s.height,size=Math.max(12,w/80);
  const marker=(p:Point,label:string,color:string,labels:boolean)=>{
    const x=p.x*w,y=p.y*h,lx=Math.max(0,Math.min(w-size*22,x+size)),ly=Math.max(size*2,Math.min(h-size,y-size));
    const glyph=`<g stroke="${color}" stroke-width="2" fill="none"><circle cx="${x}" cy="${y}" r="${size/2}"/><path d="M ${x-size} ${y} H ${x+size} M ${x} ${y-size} V ${y+size}"/></g>`;
    return glyph+(labels?`<rect x="${lx}" y="${ly-size*1.2}" width="${size*22}" height="${size*1.5}" fill="#000" fill-opacity=".85"/><text x="${lx+3}" y="${ly}" fill="${color}" font-family="sans-serif" font-size="${size}">${label} (${p.x.toFixed(4)}, ${p.y.toFixed(4)})</text>`:'');
  };
  const path=input.gridPoint?.regionPath??input.regionPath,region=path?gridRegion(path):box;
  const rect=(b:Box,color:string)=>`<rect x="${b.x*w}" y="${b.y*h}" width="${b.width*w}" height="${b.height*h}" stroke="${color}" stroke-width="2" fill="none"/>`;
  const overlay=(labels:boolean)=>`<svg width="${w}" height="${h}">${rect(region,'#00ffff')}${rect(box,'#ff4080')}${to?`<path d="M ${point.x*w} ${point.y*h} L ${to.x*w} ${to.y*h}" stroke="#ffff00" stroke-width="2"/>`:''}${marker(point,to?'START':'CLICK','#ff4080',labels)}${to?marker(to,'END','#ffff00',labels):''}</svg>`;
  const annotated=await sharp(bytes).composite([{input:Buffer.from(overlay(true))}]).png().toBuffer();
  // A detail image reveals the crosshair placement without hiding full-window context.
  const detailView=path?region:{x:Math.max(0,point.x-.12),y:Math.max(0,point.y-.12),width:0,height:0};
  if(!path){detailView.width=Math.min(.24,1-detailView.x);detailView.height=Math.min(.24,1-detailView.y);}
  // crop() expects a path, so perform the same extraction on the annotated copy.
  const left=Math.floor(detailView.x*w),top=Math.floor(detailView.y*h);
  const detailCopy=await sharp(bytes).composite([{input:Buffer.from(overlay(false))}]).png().toBuffer();
  const detail=await sharp(detailCopy).extract({left,top,width:Math.max(1,Math.min(w-left,Math.round(detailView.width*w))),height:Math.max(1,Math.min(h-top,Math.round(detailView.height*h)))}).resize({width:800}).png().toBuffer();
  return {metadata:{snapshotId:s.id,previewOnly:true,point,box,to,pixels:{x:point.x*w,y:point.y*h},detailView,imageOrder:['Annotated full window','Enlarged annotated target region'],instruction:'Crosshair is the proposed point, not evidence that the target is correct. Reuse the same target arguments for ny_act/ny_drag; usual freshness and image guards still apply.'},images:[await sharp(annotated).resize({width:1200,withoutEnlargement:true}).png().toBuffer(),detail]};
}
