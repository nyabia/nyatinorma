// SPDX-License-Identifier: MIT OR Apache-2.0
import {readFile,appendFile,readdir,mkdir,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {dataDir,saveJSON} from './config.js';
import {task,safeId} from './tasks.js';
import {activeRunPath} from './runs.js';
import {currentRun} from './runtime.js';
import {libraryDirectory,preserveEvidence} from './skills.js';
import type {Snapshot,SelectSet,Progress} from './types.js';
export async function snapshot(id?:string):Promise<Snapshot> {
  const selected=id??await readFile(resolve(dataDir,'latest.txt'),'utf8');
  if(!/^[0-9]+-[a-f0-9]{8}$/.test(selected))throw new Error('Invalid snapshot ID');
  return JSON.parse(await readFile(resolve(dataDir,'captures',selected+'.json'),'utf8'));
}
export async function setDir(){const p=resolve(activeRunPath(),'sets');await mkdir(p,{recursive:true});return p;}
export function nextSetVersion(name:string,files:string[]){safeId(name);const prefix=name+'.v';return 1+Math.max(0,...files.filter(f=>f.startsWith(prefix)&&/^\d+\.json$/.test(f.slice(prefix.length))).map(f=>Number(f.slice(prefix.length,-5))));}
export async function setVersion(name:string){return nextSetVersion(name,await readdir(await setDir()));}
export async function saveSet(value:SelectSet){const dir=await setDir();await writeFile(resolve(dir,`${safeId(value.name)}.v${value.version}.json`),JSON.stringify(value,null,2)+'\n',{flag:'wx'});await saveJSON(resolve(dir,value.name+'.json'),value);}
export async function loadSet(name:string):Promise<SelectSet>{return JSON.parse(await readFile(resolve(await setDir(),safeId(name)+'.json'),'utf8'));}
export async function listSets(){return (await readdir(await setDir())).filter(n=>n.endsWith('.json')&&!n.includes('.v')).map(n=>n.slice(0,-5));}
export async function inspectSet(name:string){
  safeId(name);const dir=await setDir(),prefix=name+'.v';
  const versions=(await readdir(dir)).filter(f=>f.startsWith(prefix)&&/^\d+\.json$/.test(f.slice(prefix.length))).map(f=>Number(f.slice(prefix.length,-5))).sort((a,b)=>a-b);
  let active:SelectSet|null=null;try{active=await loadSet(name);}catch(e:any){if(e.code!=='ENOENT')throw e;}
  return {name,active,versions};
}
export async function rollbackSet(name:string,version:number){if(!Number.isInteger(version)||version<1)throw new Error('Invalid version');const dir=await setDir();const old:SelectSet=JSON.parse(await readFile(resolve(dir,`${safeId(name)}.v${version}.json`),'utf8'));const next={...old,version:await setVersion(name),createdAt:Date.now()};await saveSet(next);return next;}
export async function retireSet(name:string,reason:string){if(!reason.trim())throw new Error('Explain why this set is retired.');await unlink(resolve(await setDir(),safeId(name)+'.json'));await trace({event:'set_retired',name,reason});return {retired:name,reason,historyPreserved:true};}
export async function publishSet(name:string,snapshotId?:string){
  const set=await loadSet(name),t=await task();
  if(t.id==='scratch')throw new Error('Save/apply a reusable preset before publishing its sets. The current run stays saved independently.');
  const dir=await libraryDirectory(t.id),evidence=snapshotId?await preserveEvidence(snapshotId):undefined;
  const published={...set,version:nextSetVersion(name,await readdir(dir)),createdAt:Date.now(),...(evidence?{validationEvidence:evidence}:{})};
  await writeFile(resolve(dir,`${safeId(name)}.v${published.version}.json`),JSON.stringify(published,null,2)+'\n',{flag:'wx'});
  await saveJSON(resolve(dir,name+'.json'),published);await trace({event:'set_published',name,presetId:t.id,version:published.version});
  return {name,presetId:t.id,version:published.version,scope:'New runs inherit this set; existing runs keep their own versions.'};
}
export async function trace(event:Record<string,unknown>){const run=currentRun();if(!run)return;await appendFile(resolve(activeRunPath(),'trace.jsonl'),JSON.stringify({at:Date.now(),taskId:run.preset.id,runId:run.id,...event})+'\n');}
export async function recentTrace(count=12){if(!currentRun())return [];try{return (await readFile(resolve(activeRunPath(),'trace.jsonl'),'utf8')).trim().split('\n').filter(Boolean).slice(-Math.min(count,40)).map(l=>JSON.parse(l));}catch(e:any){if(e.code==='ENOENT')return [];throw e;}}
export function normalizeProgress(value:Record<string,unknown>):Progress {
  if(value.schemaVersion===2)return value as Progress;
  return {schemaVersion:2,state:{},checkpoints:{},notes:Array.isArray(value.notes)?value.notes:[],legacy:value};
}
export async function progress():Promise<Progress>{const empty:Progress={schemaVersion:2,state:{},checkpoints:{},notes:[]};if(!currentRun())return empty;try{return normalizeProgress(JSON.parse(await readFile(resolve(activeRunPath(),'progress.json'),'utf8')));}catch(e:any){if(e.code!=='ENOENT')throw e;return empty;}}
export async function saveProgress(p:Progress){await saveJSON(resolve(activeRunPath(),'progress.json'),p);}
export async function recordCheckpoint(input:{snapshotId:string;note:string;key?:string;data?:Record<string,unknown>;state?:Record<string,unknown>}){
  await snapshot(input.snapshotId);
  if(!input.note.trim())throw new Error('A checkpoint needs an observation note.');
  if(input.data&&!input.key)throw new Error('Checkpoint data requires a key.');
  const p=await progress();
  if(input.state)p.state={...p.state,...input.state};
  if(input.key)p.checkpoints={...p.checkpoints,[input.key]:{data:input.data??{},snapshotId:input.snapshotId,at:Date.now()}};
  p.notes=[...p.notes,input.note].slice(-30);await saveProgress(p);await trace({event:'checkpoint',...input});
  return {recorded:input,checkpointCount:Object.keys(p.checkpoints).length};
}
