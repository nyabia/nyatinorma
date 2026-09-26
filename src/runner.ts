// SPDX-License-Identifier: MIT OR Apache-2.0
import sharp from 'sharp';
import {config} from './config.js';
import {capture,execute} from './desktop.js';
import {fingerprint,difference,validateBox,validateVisualAnchors,matchTarget,gridRegion} from './vision.js';
import {snapshot,loadSet,saveSet,setVersion,recentTrace,trace} from './store.js';
import {task,safeId} from './tasks.js';
import {checkCandidate} from './policy.js';
import {select} from './ollama.js';
import type {Candidate,SelectSet,Snapshot,Box} from './types.js';
import {requireFreshObservation} from './runtime.js';
import {acquireInput} from './input-lock.js';
import {resolveTarget,resolveDestination} from './targeting.js';
import {performAction,whole,type GroundedClick} from './action-runtime.js';
import {assertCanExecute} from './execution-state.js';

export async function defineSet(input:{name:string;screen:string;purpose?:string;anchors?:string[];visualAnchors?:Box[];visualAnchorRegions?:string[][];snapshotId:string;candidates:Candidate[]},persist=true) {
  safeId(input.name);const s=await snapshot(input.snapshotId);
  requireFreshObservation(s.at);
  if(input.anchors?.length)throw new Error('Text/OCR anchors are disabled. Use visualAnchors with observed stable image regions.');
  const anchorBoxes=[...(input.visualAnchors??[]),...(input.visualAnchorRegions??[]).map(gridRegion)];
  if(!anchorBoxes.length||anchorBoxes.length>4)throw new Error('Provide 1–4 stable visualAnchors (header, tab, or popup frame).');
  const visualAnchors=await Promise.all(anchorBoxes.map(async box=>{validateBox(box);return {box,template:await fingerprint(s.path,box)};}));
  await validateVisualAnchors(visualAnchors,s.path,(await config()).templateMaxError);
  if(input.candidates.length<1||input.candidates.length>10)throw new Error('Use 1–10 actions; WAIT and THINK are added automatically.');
  const ids=new Set<string>();
  const candidates:Candidate[]=[];
  for(const proposed of input.candidates){
    if(proposed.targetText||proposed.requiredText||proposed.targetAnchor)throw new Error('OCR targeting is disabled. Inspect a crop and supply a visually grounded box.');
    const resolved=proposed.kind==='click'?{box:whole}:resolveTarget(proposed,s.width,s.height),to=resolveDestination(proposed);
    const {point,regionPath,gridPoint,toRegionPath,toGridPoint,...rest}=proposed;
    const candidate={...rest,box:resolved.box,to,...(proposed.kind==='click'?{target:proposed.target??proposed.label}:{})};
    safeId(candidate.id);if(['think','wait'].includes(candidate.id)||ids.has(candidate.id))throw new Error('Duplicate or reserved action ID');ids.add(candidate.id);
    if(!['click','drag'].includes(candidate.kind))throw new Error('Define only click/drag candidates; control actions are built in.');
    if(candidate.box)validateBox(candidate.box);
    if(candidate.kind==='drag'&&(!candidate.to||candidate.to.x<0||candidate.to.x>1||candidate.to.y<0||candidate.to.y>1))throw new Error('Drag needs a normalized end point.');
    checkCandidate(candidate);
    candidates.push({...candidate,template:await fingerprint(s.path,candidate.box!)});
  }
  const version=persist?await setVersion(input.name):0;
  const set:SelectSet={name:input.name,version,screen:input.screen,...(input.purpose?{purpose:input.purpose}:{}),anchors:[],visualAnchors,recognition:'vision-only',candidates,createdFrom:s.id,createdAt:Date.now()};
  if(persist){await saveSet(set);await trace({event:'set_revision',set:set.name,version});}return set;
}

export async function validateSet(set:SelectSet,s:Snapshot) {
  const c=await config();
  if(set.recognition!=='vision-only'||set.anchors.length||set.candidates.some(v=>v.targetText||v.requiredText||v.targetAnchor))return {valid:[],rejected:['legacy_OCR_set: observe and redefine with visualAnchors and boxes']};
  try{await validateVisualAnchors(set.visualAnchors??[],s.path,c.templateMaxError);}catch(e:any){return {valid:[],rejected:[`screen_anchor_mismatch: ${e.message}`]};}
  const valid:Candidate[]=[],rejected:string[]=[];
  for(const candidate of set.candidates) {
    try{
      checkCandidate(candidate);
      if(candidate.kind==='click'){valid.push(candidate);continue;}
      const {box,delta}=await matchTarget(s.path,candidate.box!,candidate.template!,s.width,s.height);
      if(delta>c.templateMaxError)throw new Error(`target changed (${delta.toFixed(3)})`);
      valid.push({...candidate,box});
    }catch(e:any){rejected.push(`${candidate.id}: ${e.message}`);}
  }
  return {valid,rejected};
}

async function guardRepeatedAction(action:Candidate,fresh:Snapshot) {
  if(action.kind!=='click'||!action.box)return;
  const last=(await recentTrace(20)).findLast(e=>e.event==='dispatch');
  if(!last?.action?.box||last.action.kind!=='click')return;
  const a=action.box,b=last.action.box;
  if(Math.abs(a.x+a.width/2-b.x-b.width/2)>.005||Math.abs(a.y+a.height/2-b.y-b.height/2)>.005)return;
  const before=await snapshot(last.snapshotId);
  const whole={x:0,y:0,width:1,height:1};
  if(difference(await fingerprint(before.path,whole),await fingerprint(fresh.path,whole))<.015)
    throw new Error('Repeated click on an unchanged screen blocked. Observe/crop and revise target or wait; do not retry the same action unchanged.');
}
// One observed drag or a point confirmed by ny_locate. The low-level path is not
// exposed as a raw-coordinate click tool. Caller retains a per-run fresh capture.
export async function actOnce(input:{snapshotId:string;action:Candidate;anchor?:Box;expectation:string;grounded?:GroundedClick},signal?:AbortSignal,choose:typeof select=select) {
  const release=acquireInput();
  try{
    assertCanExecute();const original=await snapshot(input.snapshotId);requireFreshObservation(original.at);
    if(!input.expectation.trim())throw new Error('Describe the visible outcome you expect.');
    if(input.anchor){validateBox(input.anchor);if(input.action.kind==='drag')await validateVisualAnchors([{box:input.anchor,template:await fingerprint(original.path,input.anchor)}],original.path,(await config()).templateMaxError);}
    const action={...input.action,box:input.action.box??resolveTarget(input.action,original.width,original.height).box,to:resolveDestination(input.action)};
    const result=await performAction(original,{action,target:action.kind==='click'?(input.grounded?.target??action.label):undefined,grounded:input.grounded,regions:input.anchor?[input.anchor]:undefined},signal,{choose});
    if(!result.performed)return {reason:result.reason,inputSent:false as const,snapshot:result.snapshot,instruction:'No input was sent. Inspect this returned current image and revise the action if needed; do not recapture merely because the previous observation changed.'};
    await trace({event:'dispatch',mode:'OBSERVED_ACTION',action:result.action,snapshotId:result.snapshot.id,expectation:input.expectation});
    await new Promise(r=>setTimeout(r,700));
    const after=await capture(signal);
    return {reason:(result.input as any)?.focusPreserved===false?'foreground_changed: stop input':'input_sent_outcome_unverified',inputSent:true as const,point:result.action?.box?{x:result.action.box.x+result.action.box.width/2,y:result.action.box.y+result.action.box.height/2}:undefined,instruction:'Input was sent. Inspect the returned image to assess the outcome; dispatch is not proof of success.',expectation:input.expectation,beforeSnapshotId:result.snapshot.id,snapshot:after};
  }finally{release();}
}
export async function runSelect(name:string,maxSteps:number,signal?:AbortSignal,onUpdate?:(s:string)=>void,choose:typeof select=select) {
  const release=acquireInput();
  try {
    assertCanExecute();
    const c=await config(),t=await task(),set=await loadSet(name),start=Date.now();
    signal=signal?AbortSignal.any([signal,AbortSignal.timeout(c.maxRunSeconds*1000)]):AbortSignal.timeout(c.maxRunSeconds*1000);
    const steps=Math.min(Math.max(1,maxSteps),c.maxSteps);let last:Snapshot|undefined;
    let previousClick:{id:string;fingerprint:string}|undefined;const grounded=new Map<string,GroundedClick>();
    for(let step=0;step<steps;step++) {
      signal?.throwIfAborted();assertCanExecute();
      if(Date.now()-start>c.maxRunSeconds*1000)return {reason:'time_budget',steps:step,snapshot:last};
      const s=await capture(signal);last=s;
      const {valid,rejected}=await validateSet(set,s);
      if(!valid.length){await trace({event:'escalate',reason:'no_valid_targets',set:name,snapshotId:s.id,rejected});return {reason:'THINK: no valid targets',rejected,snapshot:s};}
      const actions:Candidate[]=[...valid,{id:'wait',label:'WAIT: 화면 전환이나 로딩이 끝날 때까지 대기',kind:'wait',intent:'observe'},
        {id:'think',label:'THINK: 판단이 어렵거나 새 화면이므로 계획과 후보를 다시 만든다',kind:'think',intent:'observe'}];
      onUpdate?.(`SELECT ${step+1}/${steps} · ${set.screen}`);
      const state=`전체 목표: ${t.objective}\n작업 지침: ${t.instructions.join("; ")}\n이번 단계 목표: ${set.purpose??'현재 관측에서 전체 목표를 향해 다음 단계로 이동한다.'}\n현재 화면: ${set.screen}\n현재 화면과 후보 좌표는 첨부 이미지에 근거한다.\n후보는 현재 화면의 이미지 검사를 통과했다. 작업 적합성과 제약은 목표 및 지침에 따라 판단한다. 보이지 않는 대상은 추측하지 말고, 후보가 맞지 않으면 THINK를 고른다.`;
      const waitingSince=Date.now();
      const waiting=setInterval(()=>onUpdate?.(`SELECT · 모델 대기/추론 ${Math.round((Date.now()-waitingSince)/1000)}초 · 제한 ${c.ollamaTimeoutSeconds}초`),5000);
      let decision;
      try{decision=await choose(state,actions,signal,(await sharp(s.path).resize({width:1050,withoutEnlargement:true}).png().toBuffer()).toString('base64'));}finally{clearInterval(waiting);}
      await trace({event:'decision',snapshotId:s.id,set:name,version:set.version,decision});
      if(!decision.choice||decision.legalMass<c.selectMinMass||decision.margin<c.selectMinMargin)return {reason:'THINK: uncertain selection',decision,snapshot:s};
      let action=actions.find(a=>a.id===decision.choice)!;
      if(action.kind==='think')return {reason:'THINK selected',decision,snapshot:s};
      // Selection may queue behind other Ollama clients. Always recapture before input.
      const fresh=await capture(signal);last=fresh;
      if(action.kind!=='wait') {
        const current=await validateSet(set,fresh);
        const resolved=current.valid.find(v=>v.id===action.id);
        if(!resolved)return {reason:'THINK: stale target',snapshot:fresh};
        action=resolved;
        const now=await fingerprint(fresh.path,action.box!);
        if(previousClick?.id===action.id&&difference(previousClick.fingerprint,now)<0.015)return {reason:'THINK: repeated click without target change',snapshot:fresh};
        previousClick={id:action.id,fingerprint:now};
      }
      await guardRepeatedAction(action,fresh);
      let input:any,dispatched=action,dispatchSnapshot=fresh;
      if(action.kind==='wait')input=await execute(action,fresh,signal);
      else {
        const performed=await performAction(fresh,{action,target:action.kind==='click'?(action.target??action.label):undefined,grounded:grounded.get(action.id)},signal,{choose});
        if(!performed.performed)return {reason:performed.reason,snapshot:performed.snapshot};
        if(performed.grounded)grounded.set(action.id,performed.grounded);input=performed.input;dispatched=performed.action!;dispatchSnapshot=performed.snapshot;
      }
      await trace({event:'dispatch',action:dispatched,snapshotId:dispatchSnapshot.id});
      if(input)await trace({event:'input_result',actionId:action.id,input});
      onUpdate?.(`${action.label} · ${Math.round(decision.elapsedMs)} ms`);
      // A screen transition returns control to THINK on the next fresh observation.
      // A pressed control may remain visible before the destination appears.
      // Let that transition settle before returning an image to the planner.
      await new Promise(r=>setTimeout(r,1800));
      const after=await capture(signal);last=after;
      await trace({event:'after_action',actionId:action.id,snapshotId:after.id});
      // A target app may activate a new window in response to an event. Stop
      // dispatching if that happens; never wrestle focus back from the user.
      if(input?.inputMode==='background'&&input.focusPreserved===false)return {reason:'THINK: foreground changed during background input',snapshot:after};
      if(action.kind==='drag')return {reason:'observe_result',action:action.label,snapshot:after};
    }
    return {reason:'step_budget',snapshot:last};
  }finally{release();}
}
