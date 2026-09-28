// SPDX-License-Identifier: MIT OR Apache-2.0
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {saveJSON} from './config.js';
import {activeRunPath} from './runs.js';
import {currentRun} from './runtime.js';
import {parseStopAt} from './time.js';
import type {Box,Candidate,Point,Snapshot} from './types.js';

export const reservedExecutionIds=new Set(['done','wait','rebuild','stop','found','moved','adjust','still','no_change','other_screen','unclear','smaller','larger','reverse','retry','boundary']);

export type ExecutionStatus='done'|'yielded'|'needs_decision'|'stopped'|'error';
export type InputState={delivery:'not_sent'|'sent'|'unknown';outcome:'not_applicable'|'unresolved'|'observed';actionId?:string;kind?:'click'|'drag';expectation?:string;beforeSnapshotId?:string;afterSnapshotId?:string;point?:Point;to?:Point;at?:number};
export type Evidence={claim:string;snapshotId:string};
export type ExecutionCandidate={id:string;kind:'click'|'drag';label:string;when:string;expectation:string;target?:string;drag?:{surface:string;direction:'up'|'down'|'left'|'right';amount?:'small'|'medium'|'large';view?:Box;region?:Box};next?:string[];preparedAction?:Candidate;grounded?:{target:string;source:Snapshot;box:Box}};
export type CandidateBatch={description:string;actions:ExecutionCandidate[];until?:string;progressRegion?:Box;procedure?:{name:string;version:number;state?:string};stopReason?:string;generationAttempts?:number};
export type ExecutionInput={dragOnly?:boolean;goal?:string;until?:string;doneWhen?:string;resume?:string;constraints?:string[];maxActions?:number;maxSeconds?:number;maxRebuilds?:number;mode?:'act'|'flow'|'wait'};
export type ExecutionResult={reason:string;status:ExecutionStatus;summary:string;goal:string;actions:number;rebuilds:number;selectCalls:number;elapsedMs:number;history:string[];visualMemory?:unknown;pendingOutcome?:string;snapshot?:Snapshot;evidence:Evidence[];lastInput:InputState;procedure?:CandidateBatch['procedure'];continuationId?:string;nextCall?:{resume:string};question?:string;error?:string;[key:string]:unknown};
export type Continuation={schemaVersion:1;dragOnly?:boolean;id:string;runId?:string;revision:string;goal:string;until:string;constraints:string[];mode:'act'|'flow'|'wait';createdAt:number;deadlineAt:number;updatedAt:number;phase:'select'|'after_drag'|'after_click'|'unknown'|'done'|'stopped';procedure?:CandidateBatch['procedure'];batch?:CandidateBatch;lastInput:InputState;history:string[];actions:number;rebuilds:number;selectCalls:number;waits:number;scan?:unknown;evidence?:Evidence[];lastSnapshotId?:string;lastAction?:ExecutionCandidate;lastStatus?:ExecutionStatus};

function journalPath(){return currentRun()?resolve(activeRunPath(),'execution-continuation.json'):undefined;}
function archivePath(id:string){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw new Error('Invalid continuation ID');
  return resolve(activeRunPath(),'executions',id+'.json');
}
const ephemeral=new Map<string,Continuation>();
export function newContinuation(input:{dragOnly?:boolean;revision:string;goal:string;until:string;constraints:string[];mode:'act'|'flow'|'wait'}):Continuation{
  const now=Date.now(),stopAt=currentRun()?.stopAt;return {schemaVersion:1,id:randomUUID(),runId:currentRun()?.id,revision:input.revision,goal:input.goal,until:input.until,constraints:input.constraints,mode:input.mode,...(input.dragOnly?{dragOnly:true}:{}),createdAt:now,deadlineAt:stopAt?parseStopAt(stopAt):Number.MAX_SAFE_INTEGER,updatedAt:now,phase:'select',lastInput:{delivery:'not_sent',outcome:'not_applicable'},history:[],actions:0,rebuilds:0,selectCalls:0,waits:0};
}
export async function loadContinuation(id?:string):Promise<Continuation|undefined>{
  const path=journalPath();let value:Continuation|undefined;
  if(path){
    if(id){try{value=JSON.parse(await readFile(archivePath(id),'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}}
    if(!value){try{value=JSON.parse(await readFile(path,'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}}
  }
  else if(id)value=ephemeral.get(id);
  if(!value)return undefined;
  if(value.schemaVersion!==1||value.runId!==currentRun()?.id)throw new Error('Invalid execution continuation');
  return !id||value.id===id?value:undefined;
}
export async function saveContinuation(value:Continuation){
  value.updatedAt=Date.now();const path=journalPath();
  if(path){
    await mkdir(resolve(activeRunPath(),'executions'),{recursive:true});
    // Active journal first: if archiving fails after a prepared input, future
    // callers still see that unresolved attempt and cannot silently bypass it.
    await saveJSON(path,value);await saveJSON(archivePath(value.id),value);
  }
  else ephemeral.set(value.id,structuredClone(value));
}
export async function assertNoUnresolvedInput(){
  const prior=await loadContinuation();
  if(prior&&prior.lastInput.outcome==='unresolved'&&prior.lastInput.delivery!=='not_sent')throw new Error(`Input outcome unresolved in continuation ${prior.id}; resume it and observe before another input.`);
}
