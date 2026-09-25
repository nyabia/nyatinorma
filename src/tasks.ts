// SPDX-License-Identifier: MIT OR Apache-2.0
import {readFile,readdir,mkdir,appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {dataDir,initialize,saveJSON} from './config.js';
import {currentRun,requireRun} from './runtime.js';
import {presetDirectory} from './skills.js';
export type Task = {id:string;name:string;objective:string;instructions:string[];successCriteria:string[];revision:number;updatedAt:number};
export function safeId(id:string) { if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error('ID must use lowercase letters, digits, - or _.'); return id; }
export async function initTasks() { await presetDirectory(); }

export async function task(id?:string):Promise<Task> {
  await initTasks();
  if(!id)return requireRun().preset;
  const selected=id;
  return JSON.parse(await readFile(resolve(await presetDirectory(),safeId(selected)+'.json'),'utf8'));
}
export async function listTasks():Promise<Task[]> {await initTasks(); const files=await readdir(await presetDirectory());return Promise.all(files.filter(f=>f.endsWith('.json')&&!f.includes('.v')).map(f=>task(f.slice(0,-5))));}
export async function defineTask(input:Omit<Task,'revision'|'updatedAt'>) {
  await initTasks(); safeId(input.id);
  let previous:Task|undefined;try{previous=await task(input.id);}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const next={...input,revision:(previous?.revision??0)+1,updatedAt:Date.now()};
  const dir=await presetDirectory();if(previous)await saveJSON(resolve(dir,`${input.id}.v${previous.revision}.json`),previous);
  await saveJSON(resolve(dir,input.id+'.json'),next); return next;
}
export async function rollbackTask(id:string,revision:number){
  safeId(id);if(!Number.isInteger(revision)||revision<1)throw new Error('Invalid revision');
  const old:Task=JSON.parse(await readFile(resolve(await presetDirectory(),`${id}.v${revision}.json`),'utf8'));
  return defineTask(old);
}
export async function feedback(text:string,source='human') {
  await initialize();const run=currentRun();let snapshotId:string|null=null;try{snapshotId=await readFile(resolve(dataDir,'latest.txt'),'utf8');}catch{}
  const entry={at:Date.now(),taskId:run?.preset.id??null,taskRevision:run?.preset.revision??null,runId:run?.id??null,source,text,snapshotId};
  await appendFile(resolve(dataDir,'feedback.jsonl'),JSON.stringify(entry)+'\n'); return entry;
}
