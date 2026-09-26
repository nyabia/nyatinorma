// SPDX-License-Identifier: MIT OR Apache-2.0
import {mkdir,readFile,readdir,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import sharp from 'sharp';
import {config,saveJSON,dataDir} from './config.js';
import {activeRunPath} from './runs.js';
import {safeId} from './tasks.js';
import {requireFreshObservation,currentRun} from './runtime.js';
import {snapshot,trace,nextSetVersion} from './store.js';
import {capture,execute} from './desktop.js';
import {fingerprint,difference,validateBox,validateVisualAnchors,matchTarget} from './vision.js';
import {appSkillId,preserveEvidence} from './skills.js';
import {select} from './ollama.js';
import {VisualMemory,type VisualMemoryData} from './visual-memory.js';
import {acquireInput} from './input-lock.js';
import {resolveTarget,resolveDestination} from './targeting.js';
import {DeadlineReached} from './time.js';
import {assertCanExecute} from './execution-state.js';
import {performAction,whole,type GroundedClick} from './action-runtime.js';
import type {Box,Candidate,Snapshot,VisualAnchor,TargetCoordinates,DestinationCoordinates} from './types.js';

export type FlowAction={id:string;label:string;kind:'click'|'drag';box:Box;to?:{x:number;y:number};when:string;target?:string;expectation?:string;next?:string[];targetGuard?:'image'|'region';template?:string};
export type FlowState={id:string;snapshotId:string;description:string;visualAnchors:Box[];progressRegion:Box;doneWhen:string;actions:FlowAction[];settleMs?:number;maxSettleMs?:number;maxNoProgress?:number;maxWaits?:number;memoryMode?:'progress'|'scan';anchors?:VisualAnchor[]};
export type Flow={name:string;version:number;purpose:string;entry:string;states:FlowState[];createdAt:number};
type FlowActionInput=Omit<FlowAction,'box'|'to'> & TargetCoordinates & DestinationCoordinates;
export type FlowInput=Omit<Flow,'version'|'createdAt'|'states'> & {states:(Omit<FlowState,'actions'> & {actions:FlowActionInput[]})[]};
export type WorkContract={revision:string;requests:string[]};
export function workContract(entries:readonly any[]):WorkContract{
  const requests=entries.filter(e=>e.type==='message'&&e.message?.role==='user').map(e=>{
    const c=e.message.content;return typeof c==='string'?c:c.filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('\n');
  }).filter(Boolean);
  // Preserve the original user request and all subsequent corrections in order.
  return {revision:entries.filter(e=>e.type==='message'&&e.message?.role==='user').at(-1)?.id??'none',requests};
}
async function flowDir(library=false){const dir=library?resolve(dataDir,'skills',await appSkillId(),'flows'):resolve(activeRunPath(),'flows');await mkdir(dir,{recursive:true});return dir;}
export async function listFlows(library=false){const dir=await flowDir(library);return Promise.all((await readdir(dir)).filter(f=>f.endsWith('.json')&&!f.includes('.v')&&!f.endsWith('.evidence.json')).map(async f=>{const v:Flow=JSON.parse(await readFile(resolve(dir,f),'utf8'));return {name:v.name,version:v.version,purpose:v.purpose,states:v.states.map(s=>s.id)};}));}
export async function loadFlow(name:string,version?:number,library=false):Promise<Flow>{if(version!==undefined&&(!Number.isInteger(version)||version<1))throw new Error('Invalid flow version');return JSON.parse(await readFile(resolve(await flowDir(library),safeId(name)+(version?`.v${version}`:'')+'.json'),'utf8'));}
async function saveFlow(input:Omit<Flow,'version'|'createdAt'>,library=false){const dir=await flowDir(library),version=nextSetVersion(input.name,await readdir(dir));const flow:Flow={...input,version,createdAt:Date.now()};await writeFile(resolve(dir,`${input.name}.v${version}.json`),JSON.stringify(flow,null,2)+'\n',{flag:'wx'});await saveJSON(resolve(dir,input.name+'.json'),flow);return flow;}
export async function defineFlow(input:FlowInput){
  safeId(input.name);if(!input.purpose.trim()||!input.states.length||input.states.length>12)throw new Error('A flow needs a purpose and 1–12 observed states.');
  const ids=input.states.map(s=>safeId(s.id));if(new Set(ids).size!==ids.length||!ids.includes(input.entry))throw new Error('Unique states and a valid entry are required.');
  const states:FlowState[]=[];const c=await config();
  for(const state of input.states){
    const s=await snapshot(state.snapshotId);requireFreshObservation(s.at);
    if(!state.description.trim()||!state.doneWhen.trim())throw new Error('Describe the state and a visible local completion condition (or never).');
    if(state.memoryMode&&!['progress','scan'].includes(state.memoryMode))throw new Error('Unknown memoryMode');
    validateBox(state.progressRegion);if(!state.visualAnchors.length||state.visualAnchors.length>4)throw new Error('Use 1–4 static screen anchors.');
    const anchors=await Promise.all(state.visualAnchors.map(async box=>{validateBox(box);return {box,template:await fingerprint(s.path,box)};}));
    await validateVisualAnchors(anchors,s.path,c.templateMaxError);
    if(state.actions.length>6)throw new Error('Use at most six actions per state.');
    const actionIds=new Set<string>();const actions:FlowAction[]=[];
    for(const proposed of state.actions){
      const {point,regionPath,gridPoint,toRegionPath,toGridPoint,...rest}=proposed;
      const a={...rest,box:proposed.kind==='click'?whole:resolveTarget(proposed,s.width,s.height).box,to:resolveDestination(proposed)};
      safeId(a.id);if(['done','wait','replan'].includes(a.id)||actionIds.has(a.id))throw new Error('Duplicate/reserved action ID');actionIds.add(a.id);
      if(!['click','drag'].includes(a.kind)||!a.label.trim()||!a.when.trim())throw new Error('Describe when each click/drag applies.');
      validateBox(a.box);if(a.next?.some(n=>!ids.includes(n)))throw new Error('Unknown next state');
      if(a.kind==='drag'&&(!a.to||![a.to.x,a.to.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)))throw new Error('Drag needs a normalized endpoint');
      if(a.targetGuard==='region'&&a.kind!=='drag')throw new Error('Only a grounded drag may use region targeting.');
      if(a.targetGuard&&!['image','region'].includes(a.targetGuard))throw new Error('Unknown targetGuard');
      actions.push({...a,...(a.kind==='click'?{target:a.target??a.label}:{}),targetGuard:a.targetGuard??'image',template:a.targetGuard==='region'?undefined:await fingerprint(s.path,a.box)});
    }
    const settleMs=state.settleMs??500,maxSettleMs=state.maxSettleMs??3000,maxNoProgress=state.maxNoProgress??2,maxWaits=state.maxWaits??40;
    if(!Number.isInteger(settleMs)||settleMs<200||!Number.isInteger(maxSettleMs)||maxSettleMs<settleMs||maxSettleMs>10000||!Number.isInteger(maxNoProgress)||maxNoProgress<1||maxNoProgress>3)throw new Error('Use settleMs >=200, maxSettleMs <=10000 and maxNoProgress 1–3.');
    if(!Number.isInteger(maxWaits)||maxWaits<1||maxWaits>100)throw new Error('Use maxWaits 1–100.');
    states.push({...state,anchors,actions,settleMs,maxSettleMs,maxNoProgress,maxWaits});
  }
  const flow=await saveFlow({...input,states});await trace({event:'flow_revision',name:flow.name,version:flow.version});return flow;
}
export async function manageFlow(operation:string,name:string,version?:number){
  if(operation==='inspect')return loadFlow(name,version);
  if(operation==='retire'){await unlink(resolve(await flowDir(),safeId(name)+'.json'));return {retired:name};}
  if(operation==='rollback'||operation==='import'){const old=await loadFlow(name,version,operation==='import');return saveFlow(old);}
  if(operation==='publish'){
    const flow=await loadFlow(name);
    const evidence=await Promise.all(flow.states.map(async s=>({state:s.id,image:await preserveEvidence(s.snapshotId)})));
    const published=await saveFlow(flow,true);await saveJSON(resolve(await flowDir(true),`${name}.evidence.json`),evidence);
    return {name,version:published.version,evidence,notice:'Definition and observation evidence preserved; success is not independently certified. New executions revalidate screens.'};
  }
  throw new Error('Unknown flow operation');
}
export function delay(ms:number,signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{signal?.throwIfAborted();const cancel=()=>{clearTimeout(timer);reject(signal?.reason);};const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);signal?.addEventListener('abort',cancel,{once:true});});}
export type FlowDeps={capture:typeof capture;execute:typeof execute;choose:typeof select;trace:typeof trace;sleep:typeof delay};
const defaults:FlowDeps={capture,execute,choose:select,trace,sleep:delay};
export async function runFlow(flow:Flow,contract:WorkContract,options:{maxActions?:number;maxSeconds?:number;confirmDone?:number;transientRetries?:number;signal?:AbortSignal;onUpdate?:(s:string)=>void;interrupted?:()=>boolean},overrides:Partial<FlowDeps>={}){
  const c=await config(),release=acquireInput(),d={...defaults,...overrides},start=Date.now();
  const maxActions=Math.min(options.maxActions??40,100),maxSeconds=Math.min(options.maxSeconds??c.maxRunSeconds,c.maxRunSeconds);
  if(!Number.isInteger(maxActions)||maxActions<1||!Number.isFinite(maxSeconds)||maxSeconds<1){release();throw new Error('Invalid flow budget');}
  const confirmDone=options.confirmDone??1,transientRetries=options.transientRetries??0;
  if(!Number.isInteger(confirmDone)||confirmDone<1||confirmDone>3||!Number.isInteger(transientRetries)||transientRetries<0||transientRetries>3||(transientRetries>0&&flow.states.some(s=>s.actions.length))){release();throw new Error('Invalid observation confirmation/retry budget; transient retries require an observation-only flow');}
  const timeout=AbortSignal.timeout(maxSeconds*1000),signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
  let s:Snapshot|undefined,stateId=flow.entry,allowed=[flow.entry],count=0,noProgress=0,waits=0,lastAction='none',previousState='',calls=0,doneStreak=0,transients=0;
  const grounded=new Map<string,GroundedClick>();
  const memories=new Map<string,VisualMemory>();let memoryInfo:unknown;
  const memoryPath=currentRun()?resolve(activeRunPath(),`${safeId(flow.name)}.memory.json`):undefined;
  let savedMemory:Record<string,VisualMemoryData>={};
  const check=()=>{signal.throwIfAborted();assertCanExecute();if(options.interrupted?.())throw new Error('user_instruction_pending');};
  const finish=async(reason:string,extra:Record<string,unknown>={})=>{const result={reason,name:flow.name,version:flow.version,state:stateId,actions:count,selectCalls:calls,elapsedMs:Date.now()-start,visualMemory:memoryInfo,snapshot:s,...extra};await d.trace({event:'flow_end',...result,snapshot:s?.id});return result;};
  const candidates=async(state:FlowState,image:Snapshot)=>{
    const result:FlowAction[]=[];
    for(const a of state.actions){if(a.kind==='click'||a.targetGuard==='region'){result.push(a);continue;}const m=await matchTarget(image.path,a.box,a.template!,image.width,image.height);if(m.delta<=c.templateMaxError)result.push({...a,box:m.box});}
    return result;
  };
  const matches=async(image:Snapshot)=>{const found:FlowState[]=[];for(const state of flow.states.filter(v=>allowed.includes(v.id))){
    // A single observation-only wait cannot dispatch input and needs no pixel
    // anchor: transitions are exactly what its SELECT condition must inspect.
    if(flow.states.length===1&&!state.actions.length&&!state.anchors?.length){found.push(state);continue;}
    try{await validateVisualAnchors(state.anchors??[],image.path,c.templateMaxError);found.push(state);}catch{}
  }return found;};
  try{
    check();
    if(!contract.requests.length)return await finish('missing_user_request');
    if(memoryPath){try{const prior=JSON.parse(await readFile(memoryPath,'utf8'));if(prior.version===flow.version&&prior.revision===contract.revision)savedMemory=prior.states;}catch(e:any){if(e.code!=='ENOENT')throw e;}}
    s=await d.capture(signal);
    while(count<maxActions){
      check();const matched=await matches(s);if(matched.length!==1)return await finish(matched.length?'ambiguous_screen':'unknown_screen');
      const state=matched[0];stateId=state.id;if(previousState!==stateId){noProgress=0;waits=0;doneStreak=0;transients=0;previousState=stateId;}
      let memory:Awaited<ReturnType<VisualMemory['observe']>>|undefined;
      if(state.memoryMode==='scan'){
        if(!memories.has(stateId))memories.set(stateId,new VisualMemory(state.progressRegion,100,savedMemory[stateId]));
        memory=await memories.get(stateId)!.observe(s);memoryInfo=memory.info;savedMemory[stateId]=memories.get(stateId)!.serialize();
        if(memoryPath)await saveJSON(memoryPath,{version:flow.version,revision:contract.revision,states:savedMemory});
      }
      const cycling=(memory?.info.consecutiveRevisits??0)>=3;
      const valid=cycling||noProgress>=(state.maxNoProgress??2)?[]:await candidates(state,s);
      const choices:Candidate[]=[...valid.map(a=>({...a,intent:a.when,label:`${a.label} — only when ${a.when}`})),
        {id:'done',kind:'think',intent:'done',label:`DONE: ${state.doneWhen}. Must be visible; no movement alone does not prove completion.`},
        {id:'wait',kind:'wait',intent:'wait',label:'WAIT: loading, automatic progression, countdown or a transient animation is still in progress; no input yet'},
        {id:'replan',kind:'think',intent:'replan',label:'REPLAN: unexpected screen, popup, uncertain target, blocked, or cannot prove completion'}];
      const prompt=`Current user requests, chronological; later corrections take precedence:\n${contract.requests.join('\n\n')}\nFlow goal: ${flow.purpose}\nState: ${state.description}\nLast action: ${lastAction}; actions=${count}; no visible progress=${noProgress}; waits=${waits}. Visual scan memory: ${JSON.stringify(memory?.info??null)}. If the image includes a bottom comparison, it is a previously seen region on the left and the current region on the right. Recurrence indicates a loop or lack of new content; it is not proof of the endpoint. A matching anchor only locates this screen; inspect the image for popups and action suitability. Choose DONE only on the stated visible evidence. If no progress has occurred, consider failed input as well as an end boundary. Do not infer offscreen content.`;
      options.onUpdate?.(`SELECT · ${flow.name}/${stateId} · ${count}회 · ${Math.round((Date.now()-start)/1000)}초`);
      const decision=await d.choose(prompt,choices,signal,state.memoryMode==='scan'?await memories.get(stateId)!.comparison(s,memory?.info.revisited?memory.reference:undefined):(await sharp(s.path).resize({width:1050,withoutEnlargement:true}).png().toBuffer()).toString('base64'));calls++;check();
      await d.trace({event:'flow_decision',name:flow.name,version:flow.version,state:stateId,snapshotId:s.id,choices:choices.map(a=>a.id),decision,noProgress,visualMemory:memory?.info});
      const uncertain=!decision.choice||decision.legalMass<c.selectMinMass||decision.margin<c.selectMinMargin;
      if(uncertain||decision.choice==='replan'){
        doneStreak=0;
        // A passive observer can afford another fresh frame before escalating a
        // transient animation. Never apply this tolerance to input dispatch.
        if(transients++<transientRetries){await d.sleep(2000,signal);check();s=await d.capture(signal);continue;}
        if(uncertain)return await finish('uncertain_selection',{decision});
      }else transients=0;
      if(decision.choice==='replan')return await finish(cycling?'visual_cycle':noProgress>=(state.maxNoProgress??2)?'stalled':'replan');
      if(decision.choice==='done'){
        if(++doneStreak>=confirmDone)return await finish('local_goal_observed',{doneWhen:state.doneWhen,evidenceSnapshotId:s.id,confirmations:doneStreak});
        await d.sleep(2000,signal);check();s=await d.capture(signal);continue;
      }
      doneStreak=0;
      if(decision.choice==='wait'){
        if(++waits>(state.maxWaits??40))return await finish('wait_budget');
        await d.sleep(Math.min(1000*2**Math.min(waits-1,3),8000),signal);check();s=await d.capture(signal);continue;
      }
      waits=0;const selected=valid.find(a=>a.id===decision.choice);if(!selected)return await finish('invalid_choice');
      const fresh=await d.capture(signal);check();
      if(fresh.window.pid!==s.window.pid||fresh.window.windowId!==s.window.windowId||JSON.stringify(fresh.window.frame)!==JSON.stringify(s.window.frame))return await finish('window_changed');
      const nowMatches=await matches(fresh);if(nowMatches.length!==1||nowMatches[0].id!==stateId){s=fresh;return await finish('screen_changed_during_selection');}
      const refreshed=(await candidates(state,fresh)).find(a=>a.id===selected.id);if(!refreshed){s=fresh;return await finish('target_changed_during_selection');}
      // Region drags still require the observed content to remain stable while the model was queued.
      if(difference(await fingerprint(s.path,state.progressRegion),await fingerprint(fresh.path,state.progressRegion))>c.templateMaxError){s=fresh;lastAction='observation changed during inference';if(++waits>8)return await finish('unstable_screen');continue;}
      const before=await fingerprint(fresh.path,state.progressRegion);check();
      const action:Candidate={...refreshed,intent:refreshed.when},key=`${stateId}/${action.id}`;
      const performed=await performAction(fresh,{action,target:refreshed.kind==='click'?(refreshed.target??refreshed.label):undefined,grounded:grounded.get(key),regions:state.visualAnchors},signal,{capture:d.capture,execute:d.execute,choose:d.choose,check});
      calls+=performed.selectCalls;s=performed.snapshot;
      if(!performed.performed)return await finish(performed.reason);
      if(performed.grounded)grounded.set(key,performed.grounded);
      await d.trace({event:'dispatch',mode:'SELECT_FLOW',name:flow.name,state:stateId,action:performed.action,snapshotId:s.id});
      const input=performed.input as any;count++;lastAction=action.label;
      await d.trace({event:'input_result',mode:'SELECT_FLOW',actionId:action.id,input});
      if(input?.focusPreserved===false){s=await d.capture(signal);return await finish('foreground_changed');}
      const settle=Date.now();await d.sleep(state.settleMs??500,signal);check();s=await d.capture(signal);
      let last=await fingerprint(s.path,state.progressRegion);
      while(Date.now()-settle<(state.maxSettleMs??3000)){
        await d.sleep(250,signal);check();const next=await d.capture(signal),fp=await fingerprint(next.path,state.progressRegion);s=next;
        if(difference(last,fp)<.015){last=fp;break;}last=fp;
      }
      noProgress=difference(before,last)<.015?noProgress+1:0;
      allowed=[...new Set([stateId,...(selected.next??[])])];
      await d.trace({event:'after_action',mode:'SELECT_FLOW',actionId:action.id,snapshotId:s.id,noProgress});
    }
    return await finish('action_budget');
  }catch(error){return await finish(error instanceof DeadlineReached?'deadline_reached':timeout.aborted&&!options.signal?.aborted?'time_budget':signal.aborted?'cancelled':'error',{error:error instanceof Error?error.message:String(error)});}
  finally{release();}
}
