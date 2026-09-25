// SPDX-License-Identifier: MIT OR Apache-2.0
import sharp from 'sharp';
import {validateBox} from './vision.js';
import {selectionPrompt,type SelectHistory} from './ollama.js';
import type {Box,Point,Snapshot,Decision} from './types.js';

type Choice={id:string;label:string};
type Frame={view:Box;point:Point;history:SelectHistory};
export type LocateInput={target:string;constraints?:string;view?:Box;maxSteps?:number;minRegionPixels?:number;signal?:AbortSignal};
export type LocateStep={step:number;depth:number;view:Box;point:Point;state:string;choices:Choice[];decision:Decision;image:Buffer};
export type LocateDeps={choose:(state:string,choices:Choice[],signal:AbortSignal|undefined,image:string,history:SelectHistory)=>Promise<Decision>;minMass:number;minMargin:number;check?:()=>void;onStep?:(step:LocateStep)=>Promise<void>};

/** A half-sized viewport around a 3x3 cell, retaining neighbours at its edges. */
export function zoomCell(view:Box,index:number):{view:Box;point:Point}{
  if(!Number.isInteger(index)||index<0||index>8)throw new Error('Invalid 3x3 cell');
  const point={x:view.x+(index%3+.5)*view.width/3,y:view.y+(Math.floor(index/3)+.5)*view.height/3};
  const width=view.width/2,height=view.height/2;
  return {point,view:{x:Math.max(view.x,Math.min(view.x+view.width-width,point.x-width/2)),y:Math.max(view.y,Math.min(view.y+view.height-height,point.y-height/2)),width,height}};
}
export async function locateImage(s:Snapshot,frame:Pick<Frame,'view'|'point'>){
  const {view,point}=frame,w=s.width,h=s.height;
  const left=Math.floor(view.x*w),top=Math.floor(view.y*h),width=Math.max(1,Math.min(w-left,Math.round(view.width*w))),height=Math.max(1,Math.min(h-top,Math.round(view.height*h)));
  const bytes=await sharp(s.path).extract({left,top,width,height}).resize({width:900,height:900,fit:'inside'}).png().toBuffer();
  const meta=await sharp(bytes).metadata(),iw=meta.width!,ih=meta.height!;
  const x=(point.x*w-left)/width*iw,y=(point.y*h-top)/height*ih;
  const cells=Array.from({length:9},(_,i)=>{const cx=(i%3)*iw/3,cy=Math.floor(i/3)*ih/3;return `<rect x="${cx}" y="${cy}" width="${iw/3}" height="${ih/3}" fill="none" stroke="#00ffff" stroke-width="1"/><rect x="${cx+2}" y="${cy+2}" width="24" height="26" fill="black" fill-opacity=".8"/><text x="${cx+7}" y="${cy+22}" fill="white" font-size="21" font-family="sans-serif">${i+1}</text>`;}).join('');
  return sharp(bytes).composite([{input:Buffer.from(`<svg width="${iw}" height="${ih}">${cells}<g stroke="#ff4080" stroke-width="2" fill="none"><circle cx="${x}" cy="${y}" r="7"/><path d="M ${x-14} ${y} H ${x+14} M ${x} ${y-14} V ${y+14}"/></g></svg>`)}]).png().toBuffer();
}

/** Private visual branch. Only a confirmed coordinate leaves this function.
 * Descending appends exact request/answer pairs; ascending restores a parent
 * prefix. The main pi transcript and the original screenshot are never edited.
 */
export async function locate(s:Snapshot,input:LocateInput,deps:LocateDeps){
  const view=input.view??{x:0,y:0,width:1,height:1};validateBox(view);
  const maxSteps=input.maxSteps??6,minPixels=input.minRegionPixels??24;
  if(!input.target.trim()||!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>12||!Number.isFinite(minPixels)||minPixels<4)throw new Error('Invalid locate target or budget');
  const meta=await sharp(s.path).metadata();if(meta.width!==s.width||meta.height!==s.height)throw new Error('Snapshot dimensions disagree');
  const frames:Frame[]=[{view,point:{x:view.x+view.width/2,y:view.y+view.height/2},history:[]}];
  let calls=0;
  const check=()=>{input.signal?.throwIfAborted();deps.check?.();};
  const finish=(reason:string,frame:Frame,confirmed=false)=>({reason,snapshotId:s.id,selectCalls:calls,depth:frames.length-1,view:frame.view,...(confirmed?{point:frame.point,pixels:{x:frame.point.x*s.width,y:frame.point.y*s.height}}:{})});
  for(let step=0;step<maxSteps;step++){
    check();const frame=frames.at(-1)!,canZoom=Math.min(frame.view.width*s.width,frame.view.height*s.height)/2>=minPixels;
    // Keep all aliases stable at every depth; unavailable controls explicitly abstain.
    const choices:Choice[]=[...Array.from({length:9},(_,i)=>({id:`cell-${i+1}`,label:`Cell ${i+1}: zoom toward the desired click point inside this cell${canZoom?'':' (unavailable: native resolution limit)'}`})),
      {id:'confirm',label:'CONFIRM: pink crosshair is clearly inside the intended target at a suitable click point; target identity and conditions are satisfied'},
      {id:'back',label:frames.length>1?'ZOOM OUT: target/context lost; restore parent view':'ZOOM OUT unavailable at root; choose THINK'},
      {id:'think',label:'THINK: absent, ambiguous, unreadable, or cannot establish a suitable point'}];
    const objective=frame.history.length?'Continue locating the original target under the same constraints.':`Locate a point only; no input has been sent. Target: ${input.target}\nConstraints: ${input.constraints??'None beyond the target.'}\nUse the fixed screenshot, never invent hidden content. Image shows the current crop with cells 1–9 and a pink candidate crosshair. Pick the cell CONTAINING the desired click point, not a neighbouring cell. Grid labels/lines/crosshair are annotations, not app UI. A high score is not proof of identity. Confirm only when the crosshair is visibly a suitable point; otherwise zoom, backtrack or THINK.`;
    const state=`${objective}\nFull-window crop: ${JSON.stringify(frame.view)}; candidate: ${JSON.stringify(frame.point)}; depth=${frames.length-1}; zoomAvailable=${canZoom}.`;
    const image=await locateImage(s,frame);check();
    const decision=await deps.choose(state,choices,input.signal,image.toString('base64'),frame.history);calls++;check();
    await deps.onStep?.({step,depth:frames.length-1,view:frame.view,point:frame.point,state,choices,decision,image});check();
    if(!decision.choice||decision.truncated||decision.legalMass<deps.minMass||decision.margin<deps.minMargin)return finish('uncertain_selection',frame);
    if(decision.choice==='think')return finish('needs_planning',frame);
    if(decision.choice==='confirm')return finish('located',frame,true);
    if(decision.choice==='back'){
      if(frames.length===1)return finish('target_not_located',frame);
      frames.pop();continue;
    }
    const index=choices.findIndex(c=>c.id===decision.choice);
    if(index<0||index>8)return finish('invalid_choice',frame);
    if(!canZoom)return finish('resolution_limit',frame);
    const next=zoomCell(frame.view,index);
    const history=[...frame.history,{prompt:selectionPrompt(state,choices).user,image:image.toString('base64'),answer:String.fromCharCode(65+index)}];
    frames.push({...next,history});
  }
  return finish('step_budget',frames.at(-1)!);
}
