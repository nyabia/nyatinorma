// SPDX-License-Identifier: MIT OR Apache-2.0
import sharp from 'sharp';
import {config} from './config.js';
import {acquireInput} from './input-lock.js';
import {trace} from './store.js';
import {delay,type WorkContract} from './flow.js';
import {CuaTimeoutError} from './cua-transport.js';
import {DeadlineReached} from './time.js';
import {actionDefaults,comparisonImage,confident,performAction,whole,type ActionDeps,type GroundedClick,type GroundedDrag} from './action-runtime.js';
import {VisualMemory,type VisualMemoryData} from './visual-memory.js';
import {crop,gridOverlay} from './vision.js';
import {reservedExecutionIds,assertNoUnresolvedInput,loadContinuation,newContinuation,saveContinuation,type CandidateBatch,type Continuation,type ExecutionCandidate,type ExecutionInput,type ExecutionResult,type ExecutionStatus,type Evidence} from './execution-contract.js';
import type {Snapshot,Candidate,Decision,Box} from './types.js';

export type SupplierContext={dragOnly?:boolean;goal:string;until:string;constraints:string[];mode:'act'|'flow'|'wait';scope:string;snapshot:Snapshot;history:string[];signal:AbortSignal;remainingRebuilds:number;lastAction?:ExecutionCandidate;procedure?:CandidateBatch['procedure']};
export type CandidateSupplier=(context:SupplierContext)=>Promise<CandidateBatch>;
export type ExecutionOptions={signal?:AbortSignal;interrupted?:()=>boolean;onUpdate?:(s:string)=>void;refreshSupplier?:boolean;confirmDone?:number;transientRetries?:number;maxWaits?:number};
export type ExecutionDeps=ActionDeps & {trace:typeof trace;sleep:typeof delay};

class UserInstructionPending extends Error {constructor(){super('user_instruction_pending');}}

function validateBatch(batch:CandidateBatch){
  if(!batch||typeof batch.description!=='string'||!Array.isArray(batch.actions)||batch.actions.length>6)throw new Error('Invalid candidate batch');
  const ids=new Set<string>();
  for(const a of batch.actions){
    if(!/^[a-z][a-z0-9_-]{0,31}$/.test(a.id)||reservedExecutionIds.has(a.id)||ids.has(a.id)||!['click','drag'].includes(a.kind)||!a.label?.trim()||!a.when?.trim()||!a.expectation?.trim())throw new Error('Invalid execution candidate');
    if(a.kind==='click'&&!a.target?.trim())throw new Error('Click candidate needs a target');
    if(a.drag?.amount&&!['small','medium','large'].includes(a.drag.amount))throw new Error('Invalid drag amount');
    if(a.kind==='drag'&&!a.preparedAction&&(!a.drag?.surface?.trim()||!['up','down','left','right'].includes(a.drag.direction)))throw new Error('Drag candidate needs a surface and direction');
    ids.add(a.id);
  }
}
function summary(reason:string,j:Continuation){
  const last=j.history.at(-1);const prefix=last?`${last}. `:'';
  const descriptions:Record<string,string>={local_goal_observed:`Goal confirmed: ${j.goal}`,action_budget:'Call action budget reached',candidate_budget:'Candidate budget reached',decision_budget:'Decision budget reached',replan:'A new decision is needed',uncertain_selection:'The visual choice was uncertain',outcome_unconfirmed:'The last input result remains unconfirmed',input_outcome_unknown:'The driver did not confirm whether input was sent',input_no_effect_observed:'The sent input has no visible expected effect in two fresh observations; choose a new action',deadline_reached:'Run deadline reached',time_budget:'Call time budget reached; the goal can be resumed',cancelled:'Execution cancelled',wait_budget:'Wait budget reached',user_instruction_pending:'Paused for a new user instruction; review it before resuming',missing_user_request:'No current user request is available'};
  return prefix+(descriptions[reason]??reason.replaceAll('_',' '));
}
function statusFor(reason:string):ExecutionStatus{
  if(reason==='local_goal_observed')return 'done';
  if(['action_budget','candidate_budget','decision_budget','wait_budget','time_budget','user_instruction_pending'].includes(reason))return 'yielded';
  if(['cancelled','deadline_reached'].includes(reason))return 'stopped';
  if(reason==='error')return 'error';
  return 'needs_decision';
}
function coarseScroll(a:ExecutionCandidate,j:Continuation){return a.kind==='drag'&&j.mode==='act'&&!j.procedure&&!a.preparedAction&&a.drag?.amount!=='small';}
function inputLabel(a:ExecutionCandidate){return a.kind==='click'?a.target!:(a.drag?.surface??a.label);}
function scopeOf(j:Continuation,work:WorkContract){return `User requests (later corrections take precedence):\n${work.requests.join('\n\n')}\nLocal goal: ${j.goal}\nVisible completion condition: ${j.until}\nCurrent local constraints: ${j.constraints.join('; ')}\nWithin the user's authorized scope, current constraints override conflicting steps in an older local goal or history. Do not repeat a now-forbidden action to satisfy obsolete wording.`;}
async function frame(s:Snapshot){return (await sharp(s.path).resize({width:1050,withoutEnlargement:true}).png().toBuffer()).toString('base64');}

/** One input/observation state machine shared by adaptive, saved, and passive suppliers. */
export async function runExecution(input:ExecutionInput,supplier:CandidateSupplier,work:WorkContract,options:ExecutionOptions={},overrides:Partial<ExecutionDeps>={}):Promise<ExecutionResult>{
  const c=await config(),d={...actionDefaults,trace,sleep:delay,...overrides};
  let maxActions=input.maxActions??(input.dragOnly?80:20);
  const maxRebuilds=input.maxRebuilds??6,maxSeconds=Math.min(input.maxSeconds??c.maxRunSeconds,c.maxRunSeconds);
  if(!Number.isInteger(maxActions)||maxActions<1||maxActions>300||!Number.isInteger(maxRebuilds)||maxRebuilds<1||maxRebuilds>12||!Number.isFinite(maxSeconds)||maxSeconds<1)throw new Error('Invalid execution budget');
  if(input.until&&input.doneWhen&&input.until!==input.doneWhen)throw new Error('until and doneWhen disagree');
  if(!input.resume&&!input.goal?.trim())throw new Error('Execution requires a goal');
  const release=acquireInput();let j:Continuation;
  try{
    const active=await loadContinuation();
    if(active?.lastInput.outcome==='unresolved'&&active.lastInput.delivery!=='not_sent'&&active.id!==input.resume)await assertNoUnresolvedInput();
    if(!input.resume)await assertNoUnresolvedInput();
    const selected=input.resume?await loadContinuation(input.resume):newContinuation({revision:work.revision,goal:input.goal!,until:input.until?.trim()||input.doneWhen?.trim()||input.goal!,constraints:input.constraints??[],mode:input.mode??'act',dragOnly:input.dragOnly});
    if(!selected)throw new Error('Unknown continuation');
    if(input.resume&&input.dragOnly&&!selected.dragOnly)throw new Error('This continuation was not started as drag-only; resume it with ny_act.');
    j=selected;
    if(j.dragOnly&&input.maxActions===undefined)maxActions=80;
    if(!j.dragOnly&&maxActions>100)throw new Error('Non-scroll execution supports at most 100 actions per call.');
    if(input.resume){
      const previous={goal:j.goal,until:j.until,constraints:j.constraints};
      const revised={goal:input.goal?.trim()??j.goal,until:input.until?.trim()??input.doneWhen?.trim()??input.goal?.trim()??j.until,constraints:input.constraints??j.constraints};
      const changed=JSON.stringify(previous)!==JSON.stringify(revised),requestChanged=work.revision!==j.revision;
      if(changed||requestChanged){
        Object.assign(j,revised);j.revision=work.revision;
        // Rebuild candidates under the new scope. Never discard a dispatched
        // input's pending outcome or extend the saved deadline during amendment.
        j.batch=undefined;j.procedure=undefined;
        if(changed){j.evidence=[];j.scan=undefined;if(j.phase==='done')j.phase='select';}
        j.history.push(changed?'Local scope amended on resume; current goal/constraints supersede previous local instructions. Pending input still requires verification.':'User request revised; current goal and unresolved input require fresh visual review');
        await d.trace({event:'execution_scope_revised',continuationId:j.id,previous,current:revised,requestChanged});
      }
    }
    await saveContinuation(j);
  }catch(error){release();throw error;}
  const remaining=Math.max(1,Math.min(maxSeconds*1000,j.deadlineAt-Date.now())),timeout=AbortSignal.timeout(remaining),signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
  let s:Snapshot|undefined,callActions=0,callRebuilds=0,decisions=0,memoryInfo:unknown,repeatAction:ExecutionCandidate|undefined,transients=0;
  let region:Box=(j.scan as any)?.region??whole;
  let memory=new VisualMemory(region,40,(j.scan as any)?.data as VisualMemoryData|undefined);
  let latestSeen:Awaited<ReturnType<VisualMemory['observe']>>|undefined;
  const grounded=new Map<string,GroundedClick>();
  const groundedDrags=new Map<string,GroundedDrag>();
  const check=()=>{signal.throwIfAborted();d.check();if(options.interrupted?.())throw new UserInstructionPending();};
  const evidence:Evidence[]=[...(j.evidence??[])];
  const persist=async()=>{j.lastSnapshotId=s?.id;await saveContinuation(j);};
  const finish=async(reason:string,extra:Partial<ExecutionResult>={}):Promise<ExecutionResult>=>{
    const status=statusFor(reason);j.lastStatus=status;j.evidence=evidence;if(status==='done')j.phase='done';if(status==='stopped')j.phase='stopped';await persist();
    const result:ExecutionResult={reason,status,summary:summary(reason,j),goal:j.goal,actions:j.actions,rebuilds:j.rebuilds,selectCalls:j.selectCalls,elapsedMs:Date.now()-j.createdAt,history:j.history.slice(-8),visualMemory:memoryInfo,pendingOutcome:j.lastInput.outcome==='unresolved'?j.lastInput.expectation:undefined,snapshot:s,evidence,lastInput:j.lastInput,procedure:j.procedure,...(status==='yielded'||status==='needs_decision'?{continuationId:j.id,nextCall:{resume:j.id}}:{}),...(status==='needs_decision'?{question:reason==='input_outcome_unknown'?'Did the last input take effect? Resume to inspect its result.':reason==='input_no_effect_observed'?'The sent input showed no visible expected effect in two fresh observations. What new bounded action should be tried?':'Which bounded action or interpretation should be used next?'}:{}),...extra};
    await d.trace({event:'execution_end',reason,status,goal:j.goal,continuationId:j.id,snapshotId:s?.id,lastInput:j.lastInput});
    return result;
  };
  const choose=async(prompt:string,choices:{id:string;label:string}[],image:string)=>{const v=await d.choose(prompt,choices,signal,image);j.selectCalls++;check();await persist();return v;};
  const observe=async()=>{s=await d.capture(signal);check();latestSeen=await memory.observe(s);memoryInfo=latestSeen.info;j.scan={region,data:memory.serialize()};await persist();return latestSeen;};
  const chooseWithDetail=async(prompt:string,choices:{id:string;label:string}[],image:string,roi?:Box,prior?:Snapshot)=>{
    const first=await choose(prompt,choices,image);
    if(confident(first,c)&&!['uncertain','unclear'].includes(first.choice!))return first;
    const refine=async(v:Decision,evidenceImage:string)=>{
      if(confident(v,c)||v.truncated||v.legalMass<c.selectMinMass||choices.length<=3)return v;
      const shortlist=choices.filter(choice=>!['unclear','uncertain'].includes(choice.id)).sort((a,b)=>(v.probabilities[b.id]??0)-(v.probabilities[a.id]??0)).slice(0,2);
      const decision=await choose(`${prompt}\nThe broad next-step selection was ambiguous. Resolve these two competing interpretations using the SAME visual evidence. Neither is assumed correct; choose UNCLEAR if neither is supported.`,[...shortlist,{id:'unclear',label:'UNCLEAR: neither interpretation is established'}],evidenceImage);
      await d.trace({event:'selection_refined',continuationId:j.id,choices:shortlist.map(v=>v.id),decision});return decision;
    };
    let view=roi;
    if(!view||view.width>=.98&&view.height>=.98){
      const names=['upper left','upper middle','upper right','middle left','center','middle right','lower left','lower middle','lower right'];
      const pick=await choose(`${prompt}\nThe first reading was uncertain. Select the single 3×3 region most likely to contain the evidence needed for this decision. This only changes the inspection view; no input will be sent.`,[...names.map((name,i)=>({id:`inspect_${i}`,label:`Inspect ${name}`})),{id:'none',label:'No useful region is visible'}],await frame(s!));
      if(!confident(pick,c)||!pick.choice?.startsWith('inspect_'))return refine(first,image);
      const index=Number(pick.choice.slice(8));if(!Number.isInteger(index)||index<0||index>8)return refine(first,image);
      view={x:(index%3)/3,y:Math.floor(index/3)/3,width:1/3,height:1/3};
    }
    const original=Buffer.from(image,'base64'),meta=await sharp(original).metadata();
    const width=Math.max(1050,meta.width??1050),detailWidth=prior?Math.floor((width-20)/2):Math.min(width-20,800);
    const currentCrop=await crop(s!.path,view,detailWidth);
    const priorCrop=prior?await crop(prior.path,view,detailWidth):undefined;
    const currentHeight=(await sharp(currentCrop).metadata()).height??0,priorHeight=priorCrop?(await sharp(priorCrop).metadata()).height??0:0;
    const top=meta.height??0,detailHeight=Math.max(currentHeight,priorHeight),label=Buffer.from(`<svg width="${width}" height="30"><rect width="${width}" height="30" fill="white"/><text x="10" y="21" font-size="17">ENLARGED DETAIL ${prior?'— BEFORE (left) / CURRENT (right)':'— CURRENT'}</text></svg>`);
    const composites=[{input:original,left:0,top:0},{input:label,left:0,top},{input:currentCrop,left:priorCrop?detailWidth+10:0,top:top+30}];
    if(priorCrop)composites.push({input:priorCrop,left:0,top:top+30});
    const detailed=(await sharp({create:{width,height:top+30+detailHeight,channels:3,background:'white'}}).composite(composites).png().toBuffer()).toString('base64');
    const inspected=await choose(`${prompt}\nReview the CURRENT full context and enlarged detail${prior?' with the previous detail beside it':''}. Make the same decision once. If the evidence is still insufficient, choose the uncertain or safe stop option.`,choices,detailed);
    return refine(inspected,detailed);
  };
  const confirmDone=async(until=j.until)=>{
    for(let i=0;i<(options.confirmDone??1);i++){
      const previous=s,afterScroll=j.lastInput.kind==='drag'&&j.lastInput.outcome==='observed';
      await observe();
      const before=j.lastInput.outcome==='observed'&&j.lastInput.beforeSnapshotId?await import('./store.js').then(m=>m.snapshot(j.lastInput.beforeSnapshotId!)).catch(()=>undefined):undefined;
      const image=afterScroll&&previous?await comparisonImage(previous,s!,[],j.lastAction?.drag?.region??j.batch?.progressRegion):(await gridOverlay(Buffer.from(await frame(s!),'base64'))).toString('base64');
      const verdict=await chooseWithDetail(`${scopeOf(j,work)}\nCompletion check for: ${until}. Judge every required condition of the requested final state, not merely progress toward it. ${afterScroll?'Compare the prior post-drag view with the fresh CURRENT view. Confirm the target remains readable and sufficiently settled for the requested final state, rather than only passing through it during inertia. A presence-only search may finish when identity is clear and the item remains in view; precise alignment requires its position to be stable enough. Decorative animation need not stop. Judge spatial conditions within the current window, not the combined image.':'The image has a 4×4 reference grid: rows A/B are the upper half, C/D the lower half; columns 1/2 are the left half, 3/4 the right half. Check spatial conditions against these boundaries.'} Fully inside requires the entire target within the requested region; partial overlap is insufficient. Closing, dismissing, removing or leaving a target requires its ABSENCE, not its continued visibility. A successor screen mentioning similar words is not necessarily the original target. When present, the full-window grid belongs to the CURRENT screen. Prior input information is history, not evidence that the goal is now satisfied. Last input: ${j.lastAction?.label??'none'}; expected effect (a hypothesis, not proof): ${j.lastInput.expectation??'none'}. A changed screen alone is insufficient, but do not require the removed target to remain visible.`,[{id:'yes',label:'YES: visual evidence satisfies the termination condition, including any required absence'},{id:'no',label:'NO: at least one required condition is unmet, even if progress occurred'},{id:'uncertain',label:'UNCERTAIN: image cannot establish the final state'}],image,j.batch?.progressRegion??j.lastAction?.drag?.region??j.lastAction?.drag?.view,afterScroll?previous:before);
      if(!confident(verdict,c)||verdict.choice!=='yes')return false;
      evidence.push({claim:until,snapshotId:s!.id});
    }
    return true;
  };
  try{
    if(j.phase==='done'){
      if(j.lastSnapshotId)s=await import('./store.js').then(m=>m.snapshot(j.lastSnapshotId)).catch(()=>undefined);
      return await finish('local_goal_observed');
    }
    if(j.phase==='stopped'){
      if(Date.now()>=j.deadlineAt)return await finish('deadline_reached');
      j.phase=j.lastInput.outcome==='unresolved'?'unknown':'select';await persist();
    }
    if(!work.requests.length)return await finish('missing_user_request');
    if(Date.now()>=j.deadlineAt)return await finish('deadline_reached');
    await observe();
    // Account for SELECT and post-input checks, not just dispatched gestures.
    const decisionBudget=j.dragOnly?Math.max(100,maxActions*4+maxRebuilds*3):100;
    while(decisions++<decisionBudget){
      check();if(Date.now()>=j.deadlineAt)return await finish('deadline_reached');
      const scope=scopeOf(j,work);
      // A prepared dispatch may have reached the OS before interruption. Resume
      // with observation only; no new input choices are shown until resolved.
      if(j.lastInput.outcome==='unresolved'&&(j.phase==='unknown'||j.lastInput.delivery==='unknown')){
        const before=j.lastInput.beforeSnapshotId?await import('./store.js').then(m=>m.snapshot(j.lastInput.beforeSnapshotId!)).catch(()=>undefined):undefined;
        const sameWindow=(old:Snapshot,current:Snapshot)=>old.window.pid===current.window.pid&&old.window.windowId===current.window.windowId;
        if(before&&!sameWindow(before,s!))return await finish('input_outcome_unknown',{summary:'The window changed after the prior input. Its outcome cannot be inferred from the current window.'});
        const canCheckNoEffect=j.lastInput.delivery==='sent'&&j.lastInput.kind==='click'&&!!before&&sameWindow(before,s!);
        const choices=[{id:'observed',label:'Expected result is visibly present'},{id:'wait',label:'Transition is still underway; observe again'},{id:'decision',label:'Cannot establish whether input took effect'},...(canCheckNoEffect?[{id:'no_effect',label:'Expected effect absent; original actionable control remains visibly in its prior state; no transition is underway'}]:[])];
        const noEffectPrompt='Choose NO_EFFECT only when the expected effect is absent, the original actionable control is visibly in its prior state, and no transition is underway. A changed window or uncertain state requires DECISION. This observation cannot prove that no transient effect ever occurred.';
        const v=await chooseWithDetail(`${scope}\nThe previous ${j.lastInput.kind??'input'} ${j.lastInput.delivery==='sent'?'was sent':'may have been sent'}. Expected result: ${j.lastInput.expectation}. Inspect only this image; no new input is allowed yet. ${canCheckNoEffect?noEffectPrompt:''}`,choices,canCheckNoEffect?await comparisonImage(before!,s!):await frame(s!),j.lastAction?.grounded?.box??j.batch?.progressRegion,before);
        if(v.choice==='no_effect'&&canCheckNoEffect&&confident(v,c)){
          await d.sleep(1500,signal);await observe();
          if(!sameWindow(before!,s!))return await finish('input_outcome_unknown');
          const second=await chooseWithDetail(`${scope}\nSecond fresh observation of the sent click. Expected result: ${j.lastInput.expectation}. ${noEffectPrompt} Do not infer that the input never had a transient effect.`,choices,await comparisonImage(before!,s!),j.lastAction?.grounded?.box??j.batch?.progressRegion,before);
          if(confident(second,c)&&second.choice==='no_effect'){
            j.lastInput={...j.lastInput,outcome:'observed',afterSnapshotId:s!.id};j.phase='select';j.waits=0;
            j.history.push(`Sent ${j.lastInput.kind} showed no visible expected effect in two fresh observations; original control remained in its prior state. A new decision is needed; do not replay the input automatically.`);
            j.batch=undefined;await persist();return await finish('input_no_effect_observed');
          }
          if(!confident(second,c)||second.choice==='decision')return await finish('input_outcome_unknown');
          if(second.choice==='wait'){if(++j.waits>(options.maxWaits??40))return await finish('wait_budget');await d.sleep(1500,signal);await observe();continue;}
          if(second.choice!=='observed')return await finish('input_outcome_unknown');
        }
        if(!confident(v,c)||v.choice==='decision'||!choices.some(choice=>choice.id===v.choice))return await finish('input_outcome_unknown');
        if(v.choice==='wait'){if(++j.waits>(options.maxWaits??40))return await finish('wait_budget');await d.sleep(1500,signal);await observe();continue;}
        j.lastInput={...j.lastInput,outcome:'observed',afterSnapshotId:s!.id};j.phase='select';j.history.push(`Previous ${j.lastInput.kind} result observed`);j.batch=undefined;await persist();continue;
      }
      if(j.phase==='after_drag'&&j.lastAction){
        const before=j.lastInput.beforeSnapshotId;
        const old=before?await import('./store.js').then(m=>m.snapshot(before)).catch(()=>undefined):undefined;
        const a=j.lastAction;
        const image=await memory.scrollComparison(s!,old,latestSeen?.info.revisited?latestSeen.reference:undefined);
        const adaptive=j.mode==='act'&&!j.procedure&&!a.preparedAction;
        const smaller=!j.dragOnly&&a.drag?.amount==='large'?'medium':'small';
        const scrollPrompt=`${scope}\nUse the full CURRENT view for scene context, and the enlarged BEFORE/CURRENT scroll surface to read item identities. The EARLIER SEARCH VIEW, if present, helps recognize revisited content; similarity alone does not prove an endpoint. After a ${a.drag?.amount??'medium'} drag of ${a.drag?.surface} ${a.drag?.direction}. Compare the previous and current content. Classify the effect and the next scrolling decision. Do NOT wait solely because inertial scrolling or animation continues. If item identities, direction and the target search state are readable, MOVED/LARGER may continue coarse search on the same surface while content is moving. Choose STILL only when motion/loading prevents a reliable next decision, or the target needs to settle before a precise correction. Choose SMALLER/REVERSE only when the target position is clear enough to judge that correction. FOUND means no further scrolling is needed before checking completion or acting on the target. Merely seeing the target is not FOUND when its requested position still requires scrolling. Decorative motion alone is not list movement. If the target was visible before and is now lost, or another drag of the same length would overshoot its requested position, choose REVERSE if passed, SMALLER if approaching, or ADJUST if new candidates are needed instead of continuing the same route. Prefer LARGE for list searching in both scroll-only and mixed click/scroll goals. Keep LARGE while the target is absent or far away; repeated tiny drags are not the default safety strategy. SMALLER requires visible evidence that a target is near or needs fine alignment. If a SMALL or MEDIUM drag moved correctly but the target is still absent or clearly far away, prefer LARGER over MOVED to resume LARGE search. For scroll-only goals use exactly LARGE and SMALL. Do not increase distance when the target is near, passed, or unreadable. Mere list motion is not proof of progress toward the goal.`;
        const scrollChoices=[
          {id:'found',label:'FOUND: stop scrolling; the target is ready for completion checking or the next non-drag action'},{id:'moved',label:'Current distance remains appropriate: continue LARGE search, or finish a visibly nearby fine adjustment; if short drags leave the target absent/far, prefer LARGER'},...(adaptive?[{id:'smaller',label:`Target is visibly close to the requested position: use ${smaller} for fine alignment, not routine searching`},...(a.drag&&a.drag.amount!=='large'?[{id:'larger',label:'Target remains absent or far away, movement is in the correct direction with no overshoot: return to a large search drag'}]:[]),{id:'reverse',label:'The requested target was visible BEFORE and passed/lost NOW: reverse with a small drag to recover it'},{id:'retry',label:'Same gesture is still appropriate: no movement yet, but not an endpoint; retry once on this surface'}]:[]),{id:'adjust',label:'Need a different surface, view or action not represented by these choices'},{id:'boundary',label:'Visible evidence establishes a scroll boundary or search cycle; goal is still absent, report it without further scrolling'},{id:'still',label:'WAIT: motion/loading prevents reliable reading or precise target adjustment; movement alone is not a reason to wait'},{id:'no_change',label:'No relevant movement'},{id:'other_screen',label:'Different screen or scope'},{id:'unclear',label:'Insufficient visual evidence'}];
        const v=await chooseWithDetail(scrollPrompt,scrollChoices,image,a.drag?.region??a.drag?.view??j.batch?.progressRegion,old);
        await d.trace({event:'scroll_decision',continuationId:j.id,snapshotId:s!.id,beforeSnapshotId:old?.id,region,decision:v});
        if(!confident(v,c))return await finish('uncertain_selection',{summary:`Could not determine whether ${a.drag?.surface??a.label} moved or the target appeared after inspecting an enlarged current view.`});
        if(v.choice==='still'){
          if(++j.waits>(options.maxWaits??40))return await finish('wait_budget');
          // SELECT already takes time; short rechecks suffice for readable search.
          await d.sleep(coarseScroll(a,j)?Math.min(250*j.waits,1000):700,signal);await observe();continue;
        }
        j.lastInput={...j.lastInput,outcome:'observed',afterSnapshotId:s!.id};j.phase='select';j.waits=0;
        if(adaptive&&['smaller','larger','reverse','retry'].includes(v.choice!)&&a.drag){
          const opposite={up:'down',down:'up',left:'right',right:'left'} as const;
          const next:ExecutionCandidate={...a,drag:{...a.drag,direction:v.choice==='reverse'?opposite[a.drag.direction]:a.drag.direction,amount:v.choice==='reverse'?'small':v.choice==='smaller'?smaller:v.choice==='larger'?'large':a.drag.amount}};
          j.history.push(`Visual SELECT chose ${v.choice}: ${next.drag!.amount??'medium'} ${next.drag!.direction} on the same surface.`);
          j.batch={...(j.batch??{description:'Continue visual search',actions:[]}),actions:[next]};
          repeatAction=next;await persist();continue;
        }
        if(v.choice==='boundary'){
          j.history.push('Visual SELECT observed a scroll boundary or search cycle without establishing the goal. This does not prove the entire task is complete.');
          evidence.push({claim:'Scroll boundary or search cycle observed; requested goal not established',snapshotId:s!.id});
          j.batch=undefined;await persist();return await finish('search_boundary_observed');
        }
        if(v.choice==='adjust'){
          j.history.push('Visual SELECT requested a new surface, view or action. Reinspect the current scene and generate a suitable candidate.');
          j.batch=undefined;groundedDrags.clear();await persist();if(j.mode==='act'&&!j.procedure)continue;
          return await finish('drag_adjustment_needed',{question:'The saved procedure needs a changed drag distance or direction.'});
        }
        if(v.choice==='found'){const until=j.mode==='flow'?(j.batch?.until??j.until):j.until;j.history.push(`Drag found possible goal at ${s!.id}`);j.batch=undefined;await persist();if(await confirmDone(until))return await finish('local_goal_observed');j.history.push('The target may be visible but completion was not established. Recheck its identity and choose the next action: open/select a ready target, or fine-tune its position only if required.');continue;}
        if(v.choice==='moved'){j.history.push(`Drag moved content at ${s!.id}; goal absent`);if(j.mode==='act'&&!j.procedure)repeatAction=a;await persist();continue;}
        if(v.choice==='no_change'){groundedDrags.delete(`${a.drag?.surface??a.label}/${a.drag?.direction??''}/${a.drag?.amount??'medium'}`);j.history.push(`Drag on ${a.drag?.surface??a.label} had no observed effect. Reinspect the surface and choose a new gesture; repetition is a visual decision, not a pixel prohibition.`);j.batch=undefined;await persist();continue;}
        if(v.choice==='unclear'){j.lastInput={...j.lastInput,outcome:'unresolved'};j.phase='after_drag';j.history.push('Drag result unreadable; need a different view');j.batch=undefined;await persist();return await finish('drag_result_unclear');}
        if(j.mode==='flow'&&a.next?.length){j.batch=undefined;j.history.push('Drag led to a declared next screen; refresh saved candidates');await persist();continue;}
        return await finish('screen_changed_after_drag');
      }
      if(j.phase==='after_click'&&j.lastAction){
        const a=j.lastAction;const v=await chooseWithDetail(`${scope}\nA click on ${a.target} was dispatched. Expected: ${a.expectation}. Is that result visible now? A still-visible button does not permit repeating the click.`,[{id:'yes',label:'Expected result is visibly present'},{id:'wait',label:'Transition or loading continues'},{id:'no',label:'Expected result is not established'}],await frame(s!),a.grounded?.box??a.preparedAction?.box??j.batch?.progressRegion);
        if(confident(v,c)&&v.choice==='wait'){if(++j.waits>(options.maxWaits??40))return await finish('wait_budget');await d.sleep(1500,signal);await observe();continue;}
        if(!confident(v,c)||v.choice!=='yes'){j.phase='unknown';await persist();return await finish('outcome_unconfirmed');}
        const until=j.mode==='flow'?(j.batch?.until??j.until):j.until;j.lastInput={...j.lastInput,outcome:'observed',afterSnapshotId:s!.id};j.phase='select';j.history.push(`${a.target}: expected result observed at ${s!.id}`);j.batch=undefined;await persist();if(await confirmDone(until))return await finish('local_goal_observed');continue;
      }
      if(!j.batch||options.refreshSupplier||j.procedure){
        const generated=j.mode==='act'&&!j.procedure;
        if(generated&&callRebuilds>=maxRebuilds)return await finish('candidate_budget');
        options.onUpdate?.(`Candidate selection ${callRebuilds+1}/${maxRebuilds}`);
        const supplied=await supplier({dragOnly:j.dragOnly,goal:j.goal,until:j.until,constraints:j.constraints,mode:j.mode,scope,snapshot:s!,history:j.history.slice(-8),signal,remainingRebuilds:maxRebuilds-callRebuilds,lastAction:j.lastAction,procedure:j.procedure});check();
        const next=j.mode==='wait'?{...supplied,actions:[]}:j.dragOnly?{...supplied,actions:supplied.actions.filter(a=>a.kind==='drag')}:supplied;validateBatch(next);
        if(generated){const used=Math.max(1,next.generationAttempts??1);j.rebuilds+=used;callRebuilds+=used;await persist();}
        if(next.stopReason)return await finish(next.stopReason);
        j.batch=next;j.procedure=next.procedure;await persist();
        // A queued supplier may have inspected an old screen. SELECT always sees
        // a fresh one, and the action runtime checks again before dispatch.
        await observe();
      }
      const batch=j.batch!;
      if(j.dragOnly)batch.actions=batch.actions.filter(a=>a.kind==='drag').map(a=>a.drag?{...a,drag:{...a.drag,amount:a.drag.amount==='small'?'small':'large'}}:a);
      const until=j.mode==='flow'?(batch.until??j.until):j.until;
      if(batch.progressRegion&&JSON.stringify(batch.progressRegion)!==JSON.stringify(region)){
        region=batch.progressRegion;memory=new VisualMemory(region,40);latestSeen=await memory.observe(s!);memoryInfo=latestSeen.info;j.scan={region,data:memory.serialize()};await persist();
      }
      options.onUpdate?.(`SELECT ${j.actions} inputs`);
      const seen=latestSeen??await memory.observe(s!);memoryInfo=seen.info;j.scan={region,data:memory.serialize()};
      const choices=[...(callActions<maxActions&&j.mode!=='wait'?batch.actions.map(a=>({id:a.id,label:`${a.kind}: ${inputLabel(a)} — ${a.when}`})):[]),{id:'done',label:`DONE: ${until} visibly true`},{id:'wait',label:'WAIT: loading or automatic progress'},{id:'rebuild',label:'REBUILD: candidates do not match current screen'},{id:'stop',label:'STOP: scope or blocker needs parent decision'}];
      if(repeatAction&&callActions>=maxActions)return await finish('action_budget');
      const v=repeatAction?{choice:repeatAction.id,legalMass:1,margin:1,truncated:false} as Decision:await chooseWithDetail(`${scope}\nCurrent state: ${batch.description}. Current completion condition: ${until}. Recent execution: ${j.history.slice(-8).join('; ')||'none'}. Revisited content is a hint, not proof of an endpoint. Choose only a visible candidate whose condition holds now.`,choices,await memory.comparison(s!,seen.info.revisited?seen.reference:undefined),batch.progressRegion);
      if(!confident(v,c)||v.choice==='unclear'){
        if(j.mode==='wait'&&transients++<(options.transientRetries??0)){await d.sleep(2000,signal);await observe();continue;}
        return await finish('uncertain_selection',{summary:`Could not distinguish the visible candidates or ${until} after inspecting an enlarged current view.`});
      }
      if(v.choice==='done'){if(await confirmDone(until))return await finish('local_goal_observed');return await finish('completion_unconfirmed');}
      if(v.choice==='stop'){
        if(j.mode==='wait'&&transients++<(options.transientRetries??0)){await d.sleep(2000,signal);await observe();continue;}
        return await finish('replan');
      }
      transients=0;
      if(v.choice==='wait'){if(++j.waits>(options.maxWaits??40))return await finish('wait_budget');await d.sleep(Math.min(1000*2**Math.min(j.waits-1,3),8000),signal);await observe();continue;}
      if(v.choice==='rebuild'){j.batch=undefined;await persist();continue;}
      if(callActions>=maxActions)return await finish('action_budget');
      if(j.mode==='wait')return await finish('invalid_choice');
      const a=batch.actions.find(x=>x.id===v.choice);if(!a)return await finish('invalid_choice');
      repeatAction=undefined;
      if(j.dragOnly&&a.kind!=='drag')return await finish('drag_only_scope');
      if(a.kind==='drag'){
        const surfaceRegion=a.drag?.region??a.drag?.view??batch.progressRegion??whole;
        if(JSON.stringify(surfaceRegion)!==JSON.stringify(region)){
          region=surfaceRegion;memory=new VisualMemory(region,40);latestSeen=await memory.observe(s!);memoryInfo=latestSeen.info;j.scan={region,data:memory.serialize()};await persist();
        }
      }
      j.waits=0;
      const action:Candidate=a.preparedAction??{id:a.id,label:a.label,kind:a.kind,intent:a.when};
      const key=a.kind==='click'?a.target!:(a.drag?.surface??a.label);
      const dragKey=`${a.drag?.surface??a.label}/${a.drag?.direction??''}/${a.drag?.amount??'medium'}`;
      const before=s!;
      const performed=await performAction(before,{action,target:a.kind==='click'?a.target:undefined,drag:a.drag,groundedDrag:groundedDrags.get(dragKey),constraints:[...j.constraints,`Local goal: ${j.goal}`,`Action applies when: ${a.when}`,`Expected effect: ${a.expectation}`].join('; '),expectation:a.expectation,grounded:a.grounded??grounded.get(key),
        beforeDispatch:async(actual,snapshot)=>{if(j.lastInput.outcome==='unresolved'&&j.lastInput.actionId!==a.id)throw new Error('Previous input outcome unresolved');const active=await loadContinuation();if(j.runId&&active?.id!==j.id)throw new Error('Active execution changed before input dispatch');if(active?.lastInput.outcome==='unresolved'&&active.lastInput.actionId!==a.id)throw new Error('Another input outcome is unresolved');const box=actual.box;const point=box?{x:box.x+box.width/2,y:box.y+box.height/2}:undefined;j.lastInput={delivery:'unknown',outcome:'unresolved',actionId:a.id,kind:a.kind,expectation:a.expectation,beforeSnapshotId:snapshot.id,point,to:actual.to,at:Date.now()};j.lastAction=a;j.phase='unknown';await persist();},
        afterDispatch:async()=>{j.lastInput={...j.lastInput,delivery:'sent'};j.phase=a.kind==='drag'?'after_drag':'after_click';j.actions++;callActions++;j.history.push(`${a.label}: dispatched; expected ${a.expectation}`);await persist();},
        onNotDispatched:async reason=>{if(j.lastInput.actionId===a.id&&j.lastInput.outcome==='unresolved'){j.lastInput={...j.lastInput,delivery:'not_sent',outcome:'not_applicable'};j.phase='select';j.lastAction=undefined;j.history.push(`${a.label}: driver did not send input (${reason})`);await persist();}}
      },signal,{...d,check});
      j.selectCalls+=performed.selectCalls;s=performed.snapshot;check();
      if(!performed.performed){
        j.history.push(`${a.label}: no input (${performed.reason})`);
        if(performed.reason==='drag_route_changed_or_uncertain'){
          // A read-only comparison was inconclusive; SELECT can reassess the
          // live scene and route inside this same bounded execution.
          groundedDrags.delete(dragKey);latestSeen=await memory.observe(s);memoryInfo=latestSeen.info;j.scan={region,data:memory.serialize()};await persist();continue;
        }
        j.batch=undefined;await persist();if(['window_changed','drag_route_unverified'].includes(performed.reason))return await finish(performed.reason);continue;
      }
      if(performed.grounded)grounded.set(key,performed.grounded);
      if('groundedDrag' in performed&&performed.groundedDrag)groundedDrags.set(dragKey,performed.groundedDrag);
      await persist();
      await d.trace({event:'dispatch',mode:j.mode,snapshotId:s.id,action:performed.action,continuationId:j.id});
      if((performed.input as any)?.focusPreserved===false)return await finish('foreground_changed');
      // Read coarse scrolling promptly; alignment/clicks keep a settling interval.
      await d.sleep(coarseScroll(a,j)?200:700,signal);await observe();
    }
    return await finish('decision_budget');
  }catch(error){
    const reason=error instanceof CuaTimeoutError&&['click','drag'].includes(error.operation)?'input_outcome_unknown':error instanceof DeadlineReached?'deadline_reached':error instanceof UserInstructionPending?'user_instruction_pending':timeout.aborted&&!options.signal?.aborted?(Date.now()>=j.deadlineAt?'deadline_reached':'time_budget'):signal.aborted?'cancelled':'error';
    return await finish(reason,{error:error instanceof Error?error.message:String(error)});
  }finally{release();}
}
