// SPDX-License-Identifier: MIT OR Apache-2.0
import sharp from 'sharp';
import {validateBox} from './vision.js';
import {selectionPrompt,type SelectHistory} from './ollama.js';
import type {Box,Point,Snapshot,Decision} from './types.js';

type Choice={id:string;label:string};
type Phase='verify'|'search'|'move';
const directions=[[-1,-1,'up-left'],[0,-1,'up'],[1,-1,'up-right'],[-1,0,'left'],[1,0,'right'],[-1,1,'down-left'],[0,1,'down'],[1,1,'down-right']] as const;
type Frame={view:Box;point:Point;history:SelectHistory;phase:Phase;tried:Set<number>;adjusting:boolean;moveScale:number};
export type LocateInput={target:string;constraints?:string;view?:Box;maxSteps?:number;minRegionPixels?:number;signal?:AbortSignal};
export type LocateStep={step:number;depth:number;phase:Phase;view:Box;point:Point;state:string;choices:Choice[];decision:Decision;image:Buffer};
export type LocateDeps={choose:(state:string,choices:Choice[],signal:AbortSignal|undefined,image:string,history:SelectHistory)=>Promise<Decision>;minMass:number;minMargin:number;check?:()=>void;onStep?:(step:LocateStep)=>Promise<void>};

/** A half-sized viewport around a 3x3 cell, retaining neighbours at its edges. */
export function zoomCell(view:Box,index:number):{view:Box;point:Point}{
  if(!Number.isInteger(index)||index<0||index>8)throw new Error('Invalid 3x3 cell');
  const point={x:view.x+(index%3+.5)*view.width/3,y:view.y+(Math.floor(index/3)+.5)*view.height/3};
  const width=view.width/2,height=view.height/2;
  return {point,view:{x:Math.max(view.x,Math.min(view.x+view.width-width,point.x-width/2)),y:Math.max(view.y,Math.min(view.y+view.height-height,point.y-height/2)),width,height}};
}
/** Move only the proposed point. Native-pixel lower bound avoids ineffective
 * subpixel edits; half-pixel margins keep coordinates strictly inside the view.
 */
export function movePoint(s:Pick<Snapshot,'width'|'height'>,view:Box,point:Point,index:number,scale=1/8):Point{
  if(!Number.isInteger(index)||index<0||index>=directions.length||!Number.isFinite(scale)||scale<=0)throw new Error('Invalid point move');
  const [dx,dy]=directions[index],mx=Math.min(.5/s.width,view.width/2),my=Math.min(.5/s.height,view.height/2);
  return {x:Math.max(view.x+mx,Math.min(view.x+view.width-mx,point.x+dx*Math.max(1/s.width,view.width*scale))),
    y:Math.max(view.y+my,Math.min(view.y+view.height-my,point.y+dy*Math.max(1/s.height,view.height*scale)))};
}
const samePoint=(a:Point,b:Point)=>Math.abs(a.x-b.x)<1e-12&&Math.abs(a.y-b.y)<1e-12;

export async function locateImage(s:Snapshot,frame:Pick<Frame,'view'|'point'>,grid=true,moves:Point[]=[]){
  const {view,point}=frame,w=s.width,h=s.height;
  const left=Math.floor(view.x*w),top=Math.floor(view.y*h),width=Math.max(1,Math.min(w-left,Math.round(view.width*w))),height=Math.max(1,Math.min(h-top,Math.round(view.height*h)));
  const bytes=await sharp(s.path).extract({left,top,width,height}).resize({width:900,height:900,fit:'inside'}).png().toBuffer();
  const meta=await sharp(bytes).metadata(),iw=meta.width!,ih=meta.height!;
  const x=(point.x*w-left)/width*iw,y=(point.y*h-top)/height*ih;
  const cells=Array.from({length:9},(_,i)=>{const cx=(i%3)*iw/3,cy=Math.floor(i/3)*ih/3;return `<rect x="${cx}" y="${cy}" width="${iw/3}" height="${ih/3}" fill="none" stroke="#00ffff" stroke-width="1"/><rect x="${cx+2}" y="${cy+2}" width="24" height="26" fill="black" fill-opacity=".8"/><text x="${cx+7}" y="${cy+22}" fill="white" font-size="21" font-family="sans-serif">${String.fromCharCode(65+i)}</text>`;}).join('');
  const arrows=moves.map((p,i)=>{const px=(p.x*w-left)/width*iw,py=(p.y*h-top)/height*ih;return `<path d="M ${x} ${y} L ${px} ${py}" stroke="#00ffff" stroke-width="1"/><circle cx="${px}" cy="${py}" r="3" fill="#00ffff"/><text x="${Math.max(3,Math.min(iw-16,px+5))}" y="${Math.max(20,Math.min(ih-4,py-5))}" fill="white" stroke="black" stroke-width=".6" font-size="21" font-family="sans-serif">${String.fromCharCode(65+i)}</text>`;}).join('');
  return sharp(bytes).composite([{input:Buffer.from(`<svg width="${iw}" height="${ih}">${grid?cells:''}${arrows}<g stroke="#ff4080" stroke-width="2" fill="none"><circle cx="${x}" cy="${y}" r="7"/><path d="M ${x-14} ${y} H ${x+14} M ${x} ${y-14} V ${y+14}"/></g></svg>`)}]).png().toBuffer();
}

/** Private visual branch. Only a confirmed coordinate leaves this function.
 * Descending appends exact request/answer pairs; ascending restores a parent
 * prefix. The main pi transcript and the original screenshot are never edited.
 */
export async function locate(s:Snapshot,input:LocateInput,deps:LocateDeps){
  const view=input.view??{x:0,y:0,width:1,height:1};validateBox(view);
  const maxSteps=input.maxSteps??20,minPixels=input.minRegionPixels??24;
  if(!input.target.trim()||!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>20||!Number.isFinite(minPixels)||minPixels<4)throw new Error('Invalid locate target or budget');
  const meta=await sharp(s.path).metadata();if(meta.width!==s.width||meta.height!==s.height)throw new Error('Snapshot dimensions disagree');
  const makeFrame=(view:Box,point:Point,history:SelectHistory):Frame=>({view,point,history,phase:'verify',tried:new Set(),adjusting:false,moveScale:1/8});
  const frames:Frame[]=[makeFrame(view,{x:view.x+view.width/2,y:view.y+view.height/2},[])];
  let calls=0;
  let selection:{phase:string;choice:string|null;legalMass:number;margin:number;truncated:boolean;reason:string;explorationChoice?:string}|undefined;
  const check=()=>{input.signal?.throwIfAborted();deps.check?.();};
  const finish=(reason:string,frame:Frame,confirmed=false)=>({reason,snapshotId:s.id,selectCalls:calls,depth:frames.length-1,view:frame.view,selection,...(confirmed?{point:frame.point,pixels:{x:frame.point.x*s.width,y:frame.point.y*s.height}}:{})});
  for(let step=0;step<maxSteps;step++){
    check();const frame=frames.at(-1)!,phase=frame.phase;
    const canZoom=Math.min(frame.view.width*s.width,frame.view.height*s.height)/2>=minPixels;
    const canBack=frames.length>1||frame.view.width<1||frame.view.height<1;
    const moves=directions.map((_,i)=>movePoint(s,frame.view,frame.point,i,frame.moveScale));
    const canShrink=Math.max(frame.view.width*s.width,frame.view.height*s.height)*frame.moveScale>1;
    // Confirmation is a separate semantic question. Other equally valid click
    // locations must not compete with the current point in its score margin.
    const choices:Choice[]=phase==='verify'?
      [{id:'yes',label:'YES: the pink crosshair is clearly inside the described target at a suitable clickable point; all local conditions hold'},
       {id:'no',label:'NO: the crosshair is outside that target or is not a suitable clickable point'},
       {id:'uncertain',label:'UNCERTAIN: target identity or clickability at the crosshair is not clear'}]:phase==='move'?
      [...directions.map(([, ,name],i)=>({id:`move-${name}`,label:`${String.fromCharCode(65+i)}: move crosshair ${name} to the marked cyan point${samePoint(moves[i],frame.point)?' (unavailable at edge)':''}`})),
       {id:'smaller',label:`HALVE MOVE DISTANCE: use smaller position adjustments${canShrink?'':' (already at one native pixel)'}`},
       {id:'search',label:'GRID SEARCH: return to choosing a region to zoom'},
       ...(canBack?[{id:'back',label:'ZOOM OUT: recover wider visual context'}]:[]),
       {id:'think',label:'THINK: target cannot be reliably located'}]:
      [...Array.from({length:9},(_,i)=>({id:`cell-${i+1}`,label:`Grid ${String.fromCharCode(65+i)}: inspect a click point in this cell${frame.tried.has(i)?' (already explored; choose a different cell)':''}`})),
       {id:'move',label:'MOVE CROSSHAIR: target is nearby; adjust position without zooming'},
       ...(canBack?[{id:'back',label:'ZOOM OUT: target/context lost; inspect another region from the parent view'}]:[]),
       {id:'think',label:'THINK: target absent or ambiguous; no viable visual search remains'}];
    const objective=frame.history.length?'Continue locating the original target under the same local constraints.':`Locate a point only; no input has been sent. Target: ${input.target}\nLocal constraints: ${input.constraints??'None beyond the target.'}\nUse the fixed screenshot, never invent hidden content. This is visual grounding, not task planning. The pink crosshair is an annotation, not app UI.`;
    const question=phase==='verify'?'Judge ONLY the existing pink crosshair. Any point safely inside the intended clickable target is acceptable; it need not be the exact centre. Do not choose between alternative locations. Answer YES, NO or UNCERTAIN using its option letter.':phase==='move'?'Adjust only the proposed crosshair, never the real pointer. Cyan points A–H show the eight possible moves relative to the pink crosshair. Choose a point toward the target, halve the move distance for finer adjustments, or return to grid search/zoom out. Every moved point must pass a separate YES/NO/UNCERTAIN check.':'The current candidate was not confirmed. The image has a 3x3 grid labelled A–I. Pick a cell containing a suitable point of the target. Multiple cells may be valid: choose any untried suitable one. This only zooms and never clicks. Already explored cells: '+[...frame.tried].map(i=>String.fromCharCode(65+i)).join(', ')+'.';
    const state=`${objective}\n${question}\nFull-window crop: ${JSON.stringify(frame.view)}; candidate: ${JSON.stringify(frame.point)}; depth=${frames.length-1}.`;
    const image=await locateImage(s,frame,phase==='search',phase==='move'?moves:[]);check();
    const decision=await deps.choose(state,choices,input.signal,image.toString('base64'),frame.history);calls++;check();
    selection={phase,choice:decision.choice,legalMass:decision.legalMass,margin:decision.margin,truncated:decision.truncated,reason:decision.reason};
    await deps.onStep?.({step,depth:frames.length-1,phase,view:frame.view,point:frame.point,state,choices,decision,image});check();
    if(!Number.isFinite(decision.legalMass)||decision.legalMass<deps.minMass)return finish('uncertain_selection',frame);
    if(phase==='verify'){
      if(!decision.choice||decision.truncated)return finish('uncertain_selection',frame);
      if(!['yes','no','uncertain'].includes(decision.choice))return finish('invalid_choice',frame);
      if(decision.choice==='yes'&&Number.isFinite(decision.margin)&&decision.margin>=deps.minMargin)return finish('located',frame,true);
      if(decision.choice==='yes')selection.reason='low_confirmation_margin';
      frame.phase=frame.adjusting||!canZoom?'move':'search';continue;
    }
    // Incomplete top-k is unusable for confirmation, but known scores can guide
    // a reversible crop search. Missing candidates stay unknown, not fabricated.
    if(!decision.choice&&decision.reason!=='incomplete_top_k')return finish('uncertain_selection',frame);
    let choice=decision.choice;
    const eligible=choices.filter(c=>{
      if(c.id.startsWith('cell-'))return canZoom&&!frame.tried.has(Number(c.id.slice(5))-1);
      if(c.id.startsWith('move-'))return !samePoint(moves[directions.findIndex(([, ,name])=>c.id===`move-${name}`)],frame.point);
      return c.id!=='smaller'||canShrink;
    });
    if(!choice||!eligible.some(c=>c.id===choice)){
      choice=eligible.filter(c=>Number.isFinite(decision.probabilities[c.id])&&decision.probabilities[c.id]>0).sort((a,b)=>decision.probabilities[b.id]-decision.probabilities[a.id])[0]?.id??null;
      if(!choice)return finish('search_exhausted',frame);
      selection.explorationChoice=choice;
    }
    if(choice==='think')return finish('needs_planning',frame);
    if(choice==='back'){
      if(frames.length>1){frames.pop();frames.at(-1)!.phase='search';frames.at(-1)!.adjusting=false;continue;}
      if(canBack){frames[0]=makeFrame({x:0,y:0,width:1,height:1},{x:.5,y:.5},[]);continue;}
      return finish('target_not_located',frame);
    }
    const index=choices.findIndex(c=>c.id===choice);
    if(index<0)return finish('invalid_choice',frame);
    const history=[...frame.history,{prompt:selectionPrompt(state,choices).user,image:image.toString('base64'),answer:String.fromCharCode(65+index)}];
    if(choice==='move'){frame.adjusting=true;frame.phase='move';frame.history=history;continue;}
    if(choice==='smaller'){frame.moveScale/=2;frame.history=history;continue;}
    if(choice==='search'){frame.adjusting=false;frame.phase=canZoom?'search':'move';frame.history=history;continue;}
    if(choice.startsWith('move-')){
      const direction=directions.findIndex(([, ,name])=>choice===`move-${name}`);
      if(direction<0)return finish('invalid_choice',frame);
      frame.point=moves[direction];frame.adjusting=true;frame.phase='verify';frame.history=history;continue;
    }
    if(index>8||!canZoom)return finish('resolution_limit',frame);
    frame.tried.add(index);
    const next=zoomCell(frame.view,index);
    frames.push(makeFrame(next.view,next.point,history));
  }
  return finish('step_budget',frames.at(-1)!);
}
