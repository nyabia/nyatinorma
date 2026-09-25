// SPDX-License-Identifier: MIT OR Apache-2.0
import {mkdir,readFile,readdir,writeFile,cp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {config,dataDir,root,saveJSON} from './config.js';

export type KnowledgeScope='general'|'app'|'scenario';
export type Lesson={id:string;scope:KnowledgeScope;scenario?:string;title:string;content:string;status:'observed'|'hypothesis';evidence?:string;supersedes?:string;createdAt:number;runId?:string};
function id(value:string){if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value))throw new Error('Invalid knowledge ID');return value;}
export async function appSkillId(){const c=await config();return id(c.knowledgeAppId??((c.bundleId||c.targetApp).toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,63)||'workspace'));}
export function skillPath(name:string){return resolve(dataDir,'skills',id(name));}
async function seed(name:string){
  const path=skillPath(name);for(const dir of ['notes','evidence','presets','sets'])await mkdir(resolve(path,dir),{recursive:true});
  let text:string;try{text=await readFile(resolve(root,'resources','skills',name,'SKILL.md'),'utf8');}catch(e:any){if(e.code!=='ENOENT')throw e;text=`---\nname: ${name}\ndescription: Reusable interface knowledge and task presets for ${name}.\n---\n\nRead relevant lessons in notes/, task definitions in presets/, and candidate sets in sets/. Evidence is stored in evidence/. Reobserve the current app before applying saved knowledge.\n`;}
  try{await writeFile(resolve(path,'SKILL.md'),text,{flag:'wx'});}catch(e:any){if(e.code!=='EEXIST')throw e;}
  return path;
}
let initialized:Promise<string>|undefined;
export async function initializeSkills(){return initialized??=(async()=>{const app=await appSkillId();await seed('computer-use');const path=await seed(app);await copyIfExists(resolve(dataDir,'sets'),resolve(path,'sets'));return path;})().catch(e=>{initialized=undefined;throw e;});}
async function copyIfExists(from:string,to:string){try{await cp(from,to,{recursive:true,force:false,errorOnExist:false});}catch(e:any){if(e.code!=='ENOENT')throw e;}}
let presets:Promise<string>|undefined;const libraries=new Map<string,Promise<string>>();
export async function presetDirectory(){return presets??=(async()=>{const path=resolve(await initializeSkills(),'presets');await copyIfExists(resolve(dataDir,'tasks'),path);return path;})().catch(e=>{presets=undefined;throw e;});}
export async function libraryDirectory(presetId:string){id(presetId);if(!libraries.has(presetId))libraries.set(presetId,(async()=>{const path=resolve(await initializeSkills(),'sets',presetId);await mkdir(path,{recursive:true});await copyIfExists(resolve(dataDir,'sets',presetId),path);return path;})().catch(e=>{libraries.delete(presetId);throw e;}));return libraries.get(presetId)!;}
export async function preserveEvidence(snapshotId:string,scope:KnowledgeScope='app'){
  if(!/^[0-9]+-[a-f0-9]{8}$/.test(snapshotId))throw new Error('Invalid evidence snapshot ID');
  await initializeSkills();const dir=skillPath(scope==='general'?'computer-use':await appSkillId());
  const meta=JSON.parse(await readFile(resolve(dataDir,'captures',snapshotId+'.json'),'utf8'));
  const relative=`evidence/${snapshotId}.png`;
  await cp(resolve(dataDir,'captures',snapshotId+'.png'),resolve(dir,relative),{force:false});
  await saveJSON(resolve(dir,'evidence',snapshotId+'.json'),{...meta,path:relative});return relative;
}
export async function readLessons(scope:KnowledgeScope,scenario?:string,includeHistory=false):Promise<Lesson[]>{
  await initializeSkills();if(scope==='scenario'&&!scenario)throw new Error('scenario is required');if(scenario)id(scenario);
  const dir=resolve(skillPath(scope==='general'?'computer-use':await appSkillId()),'notes');
  const rows:Lesson[]=await Promise.all((await readdir(dir)).filter(n=>n.endsWith('.json')).map(async file=>JSON.parse(await readFile(resolve(dir,file),'utf8'))));
  const matching=rows.filter(v=>v.scope===scope&&(scope!=='scenario'||v.scenario===scenario));
  const replaced=new Set(matching.flatMap(v=>v.supersedes?[v.supersedes]:[]));
  return matching.filter(v=>includeHistory||!replaced.has(v.id)).sort((a,b)=>a.createdAt-b.createdAt);
}
export async function rememberLesson(input:{scope:KnowledgeScope;scenario?:string;title:string;content:string;status:'observed'|'hypothesis';snapshotId?:string;supersedes?:string;runId?:string}){
  if(!['general','app','scenario'].includes(input.scope)||!['observed','hypothesis'].includes(input.status))throw new Error('Invalid knowledge scope/status');
  if(!input.title.trim()||input.title.length>120||!input.content.trim()||input.content.length>2000)throw new Error('Use a short title and 1–2000 characters of reusable knowledge.');
  if(input.scope==='scenario'&&!input.scenario)throw new Error('scenario is required');if(input.scenario)id(input.scenario);
  if(input.status==='observed'&&!input.snapshotId)throw new Error('Observed knowledge requires a supporting screenshot; otherwise use hypothesis.');
  if(input.supersedes&&!(await readLessons(input.scope,input.scenario)).some(v=>v.id===input.supersedes))throw new Error('Superseded lesson must be active in this same scope and scenario.');
  await initializeSkills();const name=input.scope==='general'?'computer-use':await appSkillId();
  const evidence=input.snapshotId?await preserveEvidence(input.snapshotId,input.scope):undefined;
  const lesson:Lesson={id:`note-${Date.now()}-${randomUUID().slice(0,8)}`,scope:input.scope,...(input.scope==='scenario'?{scenario:input.scenario}:{}),title:input.title.trim(),content:input.content.trim(),status:input.status,evidence,supersedes:input.supersedes,runId:input.runId,createdAt:Date.now()};
  await writeFile(resolve(skillPath(name),'notes',lesson.id+'.json'),JSON.stringify(lesson,null,2)+'\n',{flag:'wx'});return {package:name,...lesson};
}
export async function lessonEvidence(scope:KnowledgeScope,scenario:string|undefined,lessonId:string){
  const lesson=(await readLessons(scope,scenario,true)).find(v=>v.id===id(lessonId));
  if(!lesson?.evidence||!/^evidence\/[0-9]+-[a-f0-9]{8}\.png$/.test(lesson.evidence))throw new Error('No saved image evidence for this lesson.');
  return {lesson,path:resolve(skillPath(scope==='general'?'computer-use':await appSkillId()),lesson.evidence)};
}
export async function knowledgeContext(scenario?:string){
  const app=await appSkillId();await initializeSkills();
  const scenarios=new Map<string,string>();
  const dir=await presetDirectory();for(const file of await readdir(dir)){if(!file.endsWith('.json')||file.includes('.v'))continue;const p=JSON.parse(await readFile(resolve(dir,file),'utf8'));scenarios.set(p.id,p.name);}
  const appNotes=await readLessons('app');
  const notesDir=resolve(skillPath(app),'notes');for(const file of await readdir(notesDir)){if(!file.endsWith('.json'))continue;const n:Lesson=JSON.parse(await readFile(resolve(notesDir,file),'utf8'));if(n.scope==='scenario'&&n.scenario&&!scenarios.has(n.scenario))scenarios.set(n.scenario,n.scenario);}
  const general=await readLessons('general'),specific=scenario?await readLessons('scenario',scenario):[];
  const preview=(v:Lesson)=>({...v,content:v.content.slice(0,500),truncated:v.content.length>500});
  return {app,scenario:scenario??null,instructions:{general:await readFile(resolve(skillPath('computer-use'),'SKILL.md'),'utf8'),app:await readFile(resolve(skillPath(app),'SKILL.md'),'utf8')},lessons:{general:general.slice(-3).map(preview),app:appNotes.slice(-4).map(preview),scenario:specific.slice(-5).map(preview)},counts:{general:general.length,app:appNotes.length,scenario:specific.length},availableScenarios:[...scenarios].map(([id,name])=>({id,name})),notice:'Saved lessons may be mistaken or stale. Observed means a screenshot was attached, not independent semantic verification. Read/search more with ny_knowledge; never infer current completion from knowledge.'};
}
