// SPDX-License-Identifier: MIT OR Apache-2.0
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {dataDir,saveJSON} from './config.js';
import {task} from './tasks.js';
import {snapshot,trace} from './store.js';
import {activeRunPath} from './runs.js';
import {currentRun,requireRun} from './runtime.js';

export type PlanStep={title:string;status:'pending'|'active'|'done'|'blocked';note?:string;snapshotId?:string};
export type Plan={revision:number;steps:PlanStep[];unknowns:string[];updatedAt:number};
export function validatePlan(steps:PlanStep[],unknowns:string[]) {
  if(!steps.length||steps.length>12)throw new Error('Use 1–12 short steps for the current task segment.');
  if(new Set(steps.map(s=>s.title.trim())).size!==steps.length)throw new Error('Step titles must be unique.');
  if(steps.filter(s=>s.status==='active').length>1)throw new Error('Only one step may be active.');
  for(const s of steps){
    if(!s.title.trim()||s.title.length>200||!['pending','active','done','blocked'].includes(s.status))throw new Error('Invalid plan step.');
    if(s.status==='done'&&!s.snapshotId)throw new Error('A completed game step requires a supporting snapshotId.');
    if(s.status==='blocked'&&!s.note?.trim())throw new Error('A blocked step requires a concrete reason.');
    if((s.note?.length??0)>500)throw new Error('Keep step notes under 500 characters.');
  }
  if(unknowns.length>12||unknowns.some(v=>!v.trim()||v.length>300))throw new Error('Use up to 12 short unknowns.');
}
export async function readPlan():Promise<Plan>{
  if(!currentRun())return {revision:0,steps:[],unknowns:[],updatedAt:0};
  try{return JSON.parse(await readFile(resolve(activeRunPath(),'plan.json'),'utf8'));}
  catch(e:any){if(e.code!=='ENOENT')throw e;return {revision:0,steps:[],unknowns:[],updatedAt:0};}
}
export async function writePlan(baseRevision:number,steps:PlanStep[],unknowns:string[]) {
  requireRun();
  const current=await readPlan();
  if(baseRevision!==current.revision)throw new Error(`Plan changed: read ny_plan get and revise version ${current.revision}.`);
  validatePlan(steps,unknowns);
  for(const s of steps)if(s.snapshotId)await snapshot(s.snapshotId);
  const next={revision:current.revision+1,steps,unknowns,updatedAt:Date.now()};
  await saveJSON(resolve(activeRunPath(),'plan.json'),next);
  await trace({event:'plan_revision',plan:next});return next;
}
