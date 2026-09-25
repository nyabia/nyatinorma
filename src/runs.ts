// SPDX-License-Identifier: MIT OR Apache-2.0
import {mkdir,readFile,readdir,cp,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {dataDir,saveJSON,initialize} from './config.js';
import {task,listTasks,safeId} from './tasks.js';
import {bindRun,currentRun,requireRun,type Run,type BlockedReport} from './runtime.js';
import {appSkillId,libraryDirectory} from './skills.js';
import {parseStopAt} from './time.js';

export function runPath(id:string){return resolve(dataDir,'runs',safeId(id));}
export function activeRunPath(){return runPath(requireRun().id);}
export async function loadRun(id:string):Promise<Run>{return JSON.parse(await readFile(resolve(runPath(id),'run.json'),'utf8'));}
export async function listRuns(){await initialize();await mkdir(resolve(dataDir,'runs'),{recursive:true});const names=await readdir(resolve(dataDir,'runs'));const rows=await Promise.all(names.map(async id=>{try{return await loadRun(id);}catch(e:any){if(e.code==='ENOENT')return null;throw e;}}));return rows.filter((r):r is Run=>Boolean(r)).sort((a,b)=>b.updatedAt-a.updatedAt);}
async function copyIfExists(from:string,to:string){try{await cp(from,to,{recursive:true,errorOnExist:false,force:false});}catch(e:any){if(e.code!=='ENOENT')throw e;}}
export async function createRun(presetId?:string,title?:string){
  const preset=presetId?await task(presetId):{id:'scratch',name:'자유 작업',objective:'현재 사용자가 요청한 범위만 수행한다. 아직 요청이 없으면 대화만 한다.',instructions:[],successCriteria:[],revision:1,updatedAt:Date.now()},now=Date.now(),id=`run-${now}-${randomUUID().slice(0,8)}`;
  const run:Run={id,title:title?.trim()||`${presetId?preset.name:'임시 기록'} · ${new Date(now).toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}`,preset,status:'ready',createdAt:now,updatedAt:now,anonymous:!presetId&&!title?.trim(),scenario:presetId,knowledgeApp:await appSkillId()};
  await mkdir(runPath(id),{recursive:true});
  if(presetId)await copyIfExists(await libraryDirectory(preset.id),resolve(runPath(id),'sets'));
  await saveJSON(resolve(runPath(id),'run.json'),run);return run;
}
// Import old task-scoped state once. Preserve originals and never auto-activate it.
export async function migrateLegacyRuns(){
  for(const preset of await listTasks()){
    const id=`legacy-${preset.id}`;
    try{await loadRun(id);continue;}catch(e:any){if(e.code!=='ENOENT')throw e;}
    const oldProgress=resolve(dataDir,`${preset.id}-progress.json`);
    try{await readFile(oldProgress);}catch(e:any){if(e.code==='ENOENT')continue;throw e;}
    await mkdir(runPath(id),{recursive:true});
    for(const [from,to] of [[oldProgress,'progress.json'],[resolve(dataDir,`${preset.id}-plan.json`),'plan.json'],[resolve(dataDir,'traces',preset.id+'.jsonl'),'trace.jsonl'],[resolve(dataDir,'sets',preset.id),'sets']])await copyIfExists(from,resolve(runPath(id),to));
    await saveJSON(resolve(runPath(id),'run.json'),{id,title:`이전 기록 · ${preset.name}`,preset,status:'paused',createdAt:Date.now(),updatedAt:Date.now(),legacy:true} satisfies Run);
  }
}
let held:string|null=null;
async function release(){if(held){await unlink(resolve(runPath(held),'owner.json')).catch((e:any)=>{if(e.code!=='ENOENT')throw e;});held=null;}bindRun(null);}
export async function selectRun(id:string|null){
  if(id===currentRun()?.id)return currentRun();
  const run=id?await loadRun(id):null;
  if(run?.knowledgeApp&&run.knowledgeApp!==await appSkillId())throw new Error('이 기록은 다른 앱의 기록입니다. 대상 앱 설정을 확인하세요.');
  if(run){
    const lock=resolve(runPath(run.id),'owner.json');
    try{await writeFile(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});}
    catch(e:any){
      if(e.code!=='EEXIST')throw e;
      const owner=JSON.parse(await readFile(lock,'utf8'));let alive=true;
      try{process.kill(owner.pid,0);}catch(err:any){if(err.code==='ESRCH')alive=false;else throw err;}
      if(alive)throw new Error('이 실행은 다른 터미널에서 사용 중입니다. 새 실행을 만들거나 기존 터미널에서 연결을 해제하세요.');
      await unlink(lock);await writeFile(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});
    }
  }
  await release();held=run?.id??null;bindRun(run);return run;
}
export async function setRunStatus(status:Run['status']){const current=requireRun(),now=Date.now();const run={...current,status,updatedAt:now,...(status==='ready'&&current.status==='blocked'&&current.blocked?{blocked:{...current.blocked,resumedAt:now}}:{})};await saveJSON(resolve(runPath(run.id),'run.json'),run);bindRun(run);return run;}
export async function blockRun(report:Omit<BlockedReport,'at'|'resumedAt'>){
  if(!report.reason.trim()||report.reason.length>2000||!report.needed.trim()||report.needed.length>2000||report.attempts.length>12||report.attempts.some(a=>!a.trim()||a.length>1000)||(report.progress?.length??0)>2000)throw new Error('Provide a concrete reason, concise attempts, and the intervention needed to resume.');
  const run:Run={...requireRun(),status:'blocked',blocked:{...report,at:Date.now()},updatedAt:Date.now()};
  await saveJSON(resolve(runPath(run.id),'run.json'),run);bindRun(run);return run;
}
export async function setRunDeadline(stopAt:string|null){
  if(stopAt!==null)parseStopAt(stopAt);
  const run=requireRun(),updated={...run,stopAt,updatedAt:Date.now()};
  await saveJSON(resolve(runPath(run.id),'run.json'),updated);
  // This changes a limit, not the selected task or screenshot freshness boundary.
  Object.assign(run,updated);return updated;
}
export async function configureRun(input:{title?:string;presetId?:string;scenario?:string|null}){
  const current=requireRun(),preset=input.presetId?await task(input.presetId):current.preset;
  if(input.title!==undefined&&(!input.title.trim()||input.title.length>160))throw new Error('Use a title of 1–160 characters.');
  if(input.scenario)safeId(input.scenario);
  const run:Run={...current,preset,...(input.title?{title:input.title.trim(),anonymous:false}:{}),scenario:input.scenario===null?null:input.scenario??input.presetId??current.scenario,updatedAt:Date.now()};
  if(input.presetId)await copyIfExists(await libraryDirectory(preset.id),resolve(runPath(run.id),'sets'));
  await saveJSON(resolve(runPath(run.id),'run.json'),run);bindRun(run);return run;
}
export function bindingFromBranch(entries:readonly {type:string;customType?:string;data?:unknown}[]){const entry=entries.findLast(e=>e.type==='custom'&&e.customType==='nyatinorma-run');return (entry?.data as {runId?:string|null}|undefined)?.runId??null;}
