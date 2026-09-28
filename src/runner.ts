// SPDX-License-Identifier: MIT OR Apache-2.0
import {config} from './config.js';
import {fingerprint,validateBox,validateVisualAnchors,matchTarget,gridRegion} from './vision.js';
import {snapshot,loadSet,saveSet,setVersion,trace} from './store.js';
import {task,safeId} from './tasks.js';
import {checkCandidate} from './policy.js';
import {select} from './ollama.js';
import type {Candidate,SelectSet,Snapshot,Box} from './types.js';
import {requireFreshObservation} from './runtime.js';
import {resolveTarget,resolveDestination} from './targeting.js';
import {whole,type GroundedClick} from './action-runtime.js';
import {runExecution} from './execution-controller.js';
import {runFlow,cacheFlow,type WorkContract,type Flow} from './flow.js';
import type {ExecutionCandidate} from './execution-contract.js';
import {createHash} from 'node:crypto';
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

/** Compatibility entry point: one grounded input, then the shared outcome loop. */
export async function actOnce(input:{snapshotId:string;action:Candidate;anchor?:Box;expectation:string;grounded?:GroundedClick;work?:WorkContract},signal?:AbortSignal,choose:typeof select=select){
  assertCanExecute();const original=await snapshot(input.snapshotId);
  if(!input.expectation.trim())throw new Error('Describe the visible outcome you expect.');
  if(input.anchor)validateBox(input.anchor);
  if(!['click','drag'].includes(input.action.kind))throw new Error('Expected a click or drag');
  const action={...input.action,box:input.action.box??resolveTarget(input.action,original.width,original.height).box,to:resolveDestination(input.action)};
  const candidate:ExecutionCandidate={id:'observed-action',kind:action.kind as 'click'|'drag',label:action.label,when:action.intent,expectation:input.expectation,
    ...(action.kind==='click'?{target:input.grounded?.target??action.label,grounded:input.grounded}:{}),preparedAction:action};
  const result=await runExecution({goal:`${action.label}: ${input.expectation}`,until:input.expectation,maxActions:1},async()=>({description:`Single observed action: ${action.label}`,actions:[candidate]}),
    input.work??{revision:'observed-action',requests:[action.intent,input.expectation]},{signal},{choose});
  const inputSent=result.lastInput.delivery==='sent';
  return {...result,inputSent,point:inputSent?result.lastInput.point:undefined,expectation:input.expectation,beforeSnapshotId:result.lastInput.beforeSnapshotId,
    snapshot:result.snapshot??original,instruction:result.status==='done'?'The local expected result was observed.':result.lastInput.delivery==='unknown'?'Input delivery is unknown; resume this execution to inspect before any further input.':inputSent?'Input was sent. Its result is preserved in this execution; do not blindly repeat.':'No input was sent. Use the returned current image and the reported decision.'};
}

/** Legacy sets use the same bounded executor rather than a separate replay loop. */
export async function runSelect(name:string,maxSteps:number,signal?:AbortSignal,onUpdate?:(s:string)=>void,choose:typeof select=select,work?:WorkContract){
  const set=await loadSet(name),t=await task(),c=await config();
  const goal=set.purpose??t.objective;
  const actions:Flow['states'][number]['actions']=set.candidates.filter(a=>a.kind==='click'||a.kind==='drag').map(a=>({
    id:a.id,kind:a.kind as 'click'|'drag',label:a.label,when:a.intent,target:a.target??a.label,box:a.box??whole,to:a.to,targetGuard:a.kind==='drag'?'region':'image',
  }));
  const flow:Flow={name:`set-${createHash('sha256').update(set.name).digest('hex').slice(0,16)}`,version:1,createdAt:Date.now(),purpose:goal,entry:'observed',states:[{
    id:'observed',snapshotId:set.createdFrom,description:set.screen??goal,visualAnchors:(set.visualAnchors??[]).map(a=>a.box),anchors:set.visualAnchors,
    progressRegion:whole,doneWhen:goal,actions,memoryMode:'scan',
  }]};
  const saved=await cacheFlow(flow);
  const result=await runFlow(saved,work??{revision:`set-${set.version}`,requests:[goal,...t.instructions]},{maxActions:Math.min(Math.max(1,maxSteps),c.maxSteps),signal,onUpdate},{choose});
  return {...result,steps:result.actions};
}
