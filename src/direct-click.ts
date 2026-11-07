// SPDX-License-Identifier: MIT OR Apache-2.0
import {capture,execute} from './desktop.js';
import {config} from './config.js';
import {sameWindow} from './action-runtime.js';
import {acquireInput} from './input-lock.js';
import {assertCanExecute} from './execution-state.js';
import {assertNoUnresolvedInput,newContinuation,saveContinuation,type InputState} from './execution-contract.js';
import {executionSnapshot} from './host-context.js';
import {currentRun,requireFreshObservation} from './runtime.js';
import {resolveTarget} from './targeting.js';
import {checkCandidate} from './policy.js';
import {difference,fingerprint,validateBox,validateVisualAnchors} from './vision.js';
import {InputNotSentError} from './input-error.js';
import {CuaSessionRestoredError} from './cua-transport.js';
import type {Box,Candidate,Snapshot,TargetCoordinates} from './types.js';

export type DirectClickInput=TargetCoordinates & {snapshotId:string;label:string;intent:string;anchor?:Box};
export type DirectClickResult={snapshot:Snapshot;inputSent:boolean|null;lastInput:InputState;selectCalls:0;reason:string;continuationId?:string;error?:string};
export type DirectClickDeps={capture:typeof capture;execute:typeof execute;snapshot:typeof executionSnapshot;check?:()=>void};
const defaults:DirectClickDeps={capture,execute,snapshot:executionSnapshot};

/** 좌표는 호출자가 판단한다. 이 경로는 대상 탐색·SELECT·결과 성공 판정을 하지 않는다. */
export async function directClick(input:DirectClickInput,signal?:AbortSignal,overrides:Partial<DirectClickDeps>={}):Promise<DirectClickResult>{
  const d={...defaults,...overrides},release=acquireInput();
  try{
    const check=()=>{signal?.throwIfAborted();assertCanExecute();d.check?.();signal?.throwIfAborted();};
    check();await assertNoUnresolvedInput();
    if(!input.snapshotId?.trim()||!input.label?.trim()||!input.intent?.trim())throw new Error('snapshotId, label, intent가 필요합니다.');
    const source=await d.snapshot(input.snapshotId);
    if(!source)throw new Error('화면 기록을 찾을 수 없습니다. ny_observe로 다시 관찰하세요.');
    // 호스트/독립 호출은 연결된 실행 없이도 동작한다. 연결된 실행은 재개 후 관찰을 강제한다.
    if(currentRun())requireFreshObservation(source.at);
    const {box,point}=resolveTarget(input,source.width,source.height);
    if(input.anchor)validateBox(input.anchor);
    const action:Candidate={id:'direct_click',kind:'click',label:input.label,intent:input.intent,box};
    checkCandidate(action);
    const c=await config();
    const template=await fingerprint(source.path,box);
    const anchors=input.anchor?[{box:input.anchor,template:await fingerprint(source.path,input.anchor)}]:[];
    // 화면 기준점에는 식별 가능한 무늬가 필요하지만 클릭 패치는 단색 버튼일 수도 있다.
    if(anchors.length)await validateVisualAnchors(anchors,source.path,c.templateMaxError);
    check();let current=await d.capture(signal);check();
    const notSent=(reason:string):DirectClickResult=>({snapshot:current,inputSent:false,lastInput:{delivery:'not_sent',outcome:'not_applicable'},selectCalls:0,reason});
    if(!sameWindow(source,current))return notSent('window_changed');
    // 같은 위치만 비교한다. 주변 애니메이션을 막거나 좌표를 옮겨 재탐색하지 않는다.
    if(difference(template,await fingerprint(current.path,box))>c.templateMaxError)return notSent('target_changed');
    if(anchors.length){
      try{await validateVisualAnchors(anchors,current.path,c.templateMaxError);}
      catch{return notSent('anchor_changed');}
    }
    check();await assertNoUnresolvedInput();
    const j=newContinuation({revision:'direct-click',goal:input.intent,until:input.intent,constraints:[],mode:'act'});
    j.lastAction={id:action.id,kind:'click',label:input.label,target:input.label,when:input.intent,expectation:input.intent,preparedAction:action,grounded:{target:input.label,source:current,box}};
    j.lastSnapshotId=current.id;
    j.lastInput={delivery:'unknown',outcome:'unresolved',actionId:action.id,kind:'click',expectation:input.intent,beforeSnapshotId:current.id,point,at:Date.now()};
    j.phase='unknown';
    const errors:string[]=[];
    const recordError=(error:unknown)=>{errors.push(error instanceof Error?error.message:String(error));};
    const result=(reason:string):DirectClickResult=>({snapshot:current,inputSent:j.lastInput.delivery==='unknown'?null:j.lastInput.delivery==='sent',lastInput:{...j.lastInput},selectCalls:0,reason,...(j.lastInput.outcome==='unresolved'?{continuationId:j.id}:{}),...(errors.length?{error:errors.join('; ')}:{})});
    try{
      // 전송 전에 미확정 입력을 저장한다. 저장/취소 실패 시 execute는 호출하지 않는다.
      await saveContinuation(j);check();
    }catch(error){
      recordError(error);
      j.lastInput={...j.lastInput,delivery:'not_sent',outcome:'not_applicable'};j.phase='select';
      try{await saveContinuation(j);}catch(error){recordError(error);return {...result('input_journal_failed'),continuationId:j.id};}
      return result('input_not_sent');
    }
    let reason='input_dispatched';
    try{
      await d.execute(action,current,signal);
      j.lastInput={...j.lastInput,delivery:'sent'};j.actions=1;
    }catch(error){
      recordError(error);
      // 명시적인 거절만 미전송이다. 타임아웃/통신 오류는 절대 재전송하지 않는다.
      if(error instanceof InputNotSentError||error instanceof CuaSessionRestoredError){
        j.lastInput={...j.lastInput,delivery:'not_sent',outcome:'not_applicable'};j.phase='select';reason='input_not_sent';
      }else reason='input_outcome_unknown';
    }
    let journalFailed=false;
    try{await saveContinuation(j);}catch(error){recordError(error);journalFailed=true;}
    try{
      // 전송 이후에는 실행 허용 여부가 바뀌어도 관찰을 시도한다. 성공 판정은 호출자 몫이다.
      current=await d.capture(signal);j.lastSnapshotId=current.id;
      j.lastInput={...j.lastInput,afterSnapshotId:current.id};
    }catch(error){
      recordError(error);
      // 새 이미지가 없으면 기존 미확정 저널/입력 잠금을 보존하여 ny_act resume으로 복구한다.
      return {...result('post_capture_failed'),...(journalFailed?{continuationId:j.id}:{})};
    }
    if(j.lastInput.delivery==='sent'){
      j.lastInput={...j.lastInput,outcome:'observed'};j.phase='select';
      j.history.push('좌표 클릭 전송 뒤 새 화면을 관찰함. 의도한 결과의 성공 여부는 판정하지 않음.');
    }
    try{await saveContinuation(j);}catch(error){recordError(error);return {...result('input_journal_failed'),continuationId:j.id};}
    return result(reason);
  }finally{release();}
}
