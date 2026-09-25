// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,cp,symlink,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

test('a late driver import works with pi jiti holding an older runtime namespace',async()=>{
 const {createJiti}=await import(new URL('../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs',import.meta.url).href);
 const dir=await mkdtemp(join(tmpdir(),'ny-late-runtime-'));
 try{
  const oldRuntime='let run={status:"blocked"}; export function currentRun(){return run} export function bindRun(value){run=value}';
  await writeFile(join(dir,'runtime.ts'),oldRuntime);
  await writeFile(join(dir,'entry.ts'),'import {currentRun,bindRun} from "./runtime.js"; export const loaded=currentRun(); export {bindRun}; export async function legacy(){return (await import("./legacy-guard.js")).check()} export async function current(){return (await import("./execution-state.js")).assertCanExecute()}');
  const jiti=createJiti(import.meta.url,{moduleCache:false,tryNative:false});
  const entry=await jiti.import(join(dir,'entry.ts'));
  await writeFile(join(dir,'runtime.ts'),oldRuntime+'; export function assertRunNotBlocked(){if(run.status==="blocked")throw Error("run_blocked")}');
  await writeFile(join(dir,'legacy-guard.ts'),'import {assertRunNotBlocked} from "./runtime.js"; export function check(){assertRunNotBlocked()}');
  // Exact regression: the newly read driver sees the old runtime namespace.
  await assert.rejects(entry.legacy(),/assertRunNotBlocked.*is not a function/);
  await cp(resolve('src/execution-state.ts'),join(dir,'execution-state.ts'));
  await cp(resolve('src/time.ts'),join(dir,'time.ts'));
  await assert.rejects(entry.current(),/run_blocked/);
  entry.bindRun({status:'ready',stopAt:'2000-01-01T00:00:00Z'});
  await assert.rejects(entry.current(),/deadline_reached/);
  entry.bindRun({status:'ready'});await entry.current();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('pi reload refreshes changed local runtime exports used by action tools', {timeout:30_000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ny-source-reload-')),requests:any[]=[],events:any[]=[];let next:any;
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));const tool=next;next=undefined;res.setHeader('content-type','application/x-ndjson');res.end(JSON.stringify({message:{role:'assistant',content:tool?'':'done',...(tool?{tool_calls:[tool]}:{})},done:true,prompt_eval_count:10,eval_count:3})+'\n');});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));let child:ReturnType<typeof spawn>|undefined;
 try{
  const app=join(dir,'app');await cp(resolve('src'),join(app,'src'),{recursive:true});await cp(resolve('extensions'),join(app,'extensions'),{recursive:true});
  await writeFile(join(app,'package.json'),'{"type":"module"}');await symlink(resolve('node_modules'),join(app,'node_modules'),'dir');
  const path=join(app,'src/runtime.ts'),current=await readFile(path,'utf8');
  const guardPath=join(app,'src/execution-state.ts'),guard=await readFile(guardPath,'utf8');
  await writeFile(path,current.replace(/^export function assertRunNotBlocked.*\n/m,''));
  await writeFile(guardPath,'export function assertCanExecute() {}');
  child=spawn(process.execPath,['--import','tsx',join(app,'src/cli.ts'),'tui','--mode','rpc'],{cwd:app,env:{...process.env,NYATINORMA_DATA_DIR:join(dir,'data'),NYATINORMA_MODEL:'test',NYATINORMA_OLLAMA_URL:`http://127.0.0.1:${(server.address() as any).port}`},stdio:'pipe'});
  let buffer='',errors='',serial=0;child.stderr!.on('data',b=>errors+=b);child.stdout!.on('data',b=>{buffer+=b;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{events.push(JSON.parse(line));}catch{}}});
  const wait=async(fn:()=>any)=>{const end=Date.now()+10000;while(Date.now()<end){const found=fn();if(found)return found;await new Promise(done=>setTimeout(done,25));}throw new Error('RPC timeout: '+errors+' '+JSON.stringify(events.slice(-3)));};
  const command=async(type:string,args:any={})=>{const id=String(++serial);child!.stdin!.write(JSON.stringify({type,id,...args})+'\n');const result=await wait(()=>events.find(e=>e.id===id));assert.equal(result.success,true,JSON.stringify(result));return result.data;};
  await command('get_state');
  // Change an export in a transitive dependency while the TUI process stays alive.
  await writeFile(path,current);
  await writeFile(guardPath,guard);
  await command('prompt',{message:'/reload'});
  next={function:{name:'ny_drag',arguments:{snapshotId:'1790000000000-1234abcd',label:'test',intent:'test',point:{x:.5,y:.5},to:{x:.2,y:.5},anchor:{x:.1,y:.1,width:.1,height:.1},expectation:'test'}}};
  const start=events.length;await command('prompt',{message:'Test validation only; the snapshot intentionally does not exist.'});
  await wait(()=>events.slice(start).some(e=>e.type==='agent_settled'));
  const messages=(await command('get_messages')).messages;
  const result=messages.findLast((m:any)=>m.role==='toolResult'&&m.toolName==='ny_drag');
  const text=JSON.stringify(result);
  assert.doesNotMatch(text,/is not a function/);
  assert.match(text,/ENOENT/); // Passed runtime guard, stopped before any real capture/input.
 }finally{if(child){child.kill('SIGTERM');await new Promise<void>(done=>{if(child!.exitCode!==null)done();else child!.once('exit',()=>done());});}server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(dir,{recursive:true,force:true});}
});
