// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp,mkdir,cp,symlink,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';

test('a late driver import works with pi jiti holding an older runtime namespace',async()=>{
 // Module loading is the subject of this regression; a static import would bypass jiti.
 const {createJiti}=await import(new URL('../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs',import.meta.url).href);
 const scratch=resolve(import.meta.dirname,'../.tmpdl');await mkdir(scratch,{recursive:true});
 const dir=await mkdtemp(join(scratch,'ny-late-runtime-'));
 try{
  const oldRuntime='let run={status:"blocked"}; export function currentRun(){return run} export function bindRun(value){run=value}';
  await writeFile(join(dir,'runtime.ts'),oldRuntime);
  await writeFile(join(dir,'entry.ts'),'import {currentRun,bindRun} from "./runtime.js"; export const loaded=currentRun(); export {bindRun}; export async function current(){return (await import("./execution-state.js")).assertCanExecute()}');
  const jiti=createJiti(import.meta.url,{moduleCache:false,tryNative:false});
  const entry=await jiti.import(join(dir,'entry.ts'));
  await writeFile(join(dir,'runtime.ts'),oldRuntime+'; export function assertRunNotBlocked(){if(run.status==="blocked")throw Error("run_blocked")}');
  await cp(resolve('src/execution-state.ts'),join(dir,'execution-state.ts'));
  await cp(resolve('src/time.ts'),join(dir,'time.ts'));
  await assert.rejects(entry.current(),/run_blocked/);
  entry.bindRun({status:'ready',stopAt:'2000-01-01T00:00:00Z'});
  await assert.rejects(entry.current(),/deadline_reached/);
  entry.bindRun({status:'ready'});await entry.current();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('pi reload refreshes changed local runtime exports used by action tools', {timeout:90_000},async()=>{
 const scratch=resolve(import.meta.dirname,'../.tmpdl');await mkdir(scratch,{recursive:true});
 const dir=await mkdtemp(join(scratch,'ny-source-reload-')),requests:any[]=[],events:any[]=[];let next:any;
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));const tool=next;next=undefined;res.setHeader('content-type','application/x-ndjson');res.end(JSON.stringify({message:{role:'assistant',content:tool?'':'done',...(tool?{tool_calls:[tool]}:{})},done:true,prompt_eval_count:10,eval_count:3})+'\n');});
 const listening=once(server,'listening');server.listen(0,'127.0.0.1');await listening;
 let child:ChildProcessWithoutNullStreams|undefined;
 try{
  const root=resolve(import.meta.dirname,'..'),app=join(dir,'app'),data=join(dir,'data');
  await cp(join(root,'src'),join(app,'src'),{recursive:true});await cp(join(root,'extensions'),join(app,'extensions'),{recursive:true});
  await writeFile(join(app,'package.json'),'{"type":"module"}');await symlink(join(root,'node_modules'),join(app,'node_modules'),process.platform==='win32'?'junction':'dir');
  const path=join(app,'src/runtime.ts'),current=await readFile(path,'utf8'),guardPath=join(app,'src/execution-state.ts');
  await writeFile(guardPath,'export function assertCanExecute(){throw new Error("fixture_action_v1")}');
  // RPC does not execute built-in TUI slash commands. Exercise the real reload API.
  const controls=join(app,'extensions/rpc-controls.ts');
  await writeFile(controls,'export default function(pi){pi.registerCommand("fixture-reload",{handler:async(_args,ctx)=>{await ctx.waitForIdle();await ctx.reload();}})}');
  await mkdir(join(data,'pi'),{recursive:true});await writeFile(join(data,'pi/settings.json'),JSON.stringify({quietStartup:true,retry:{enabled:false},compaction:{enabled:false}}));
  child=spawn(process.execPath,[join(root,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),'--no-builtin-tools','--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--extension',join(app,'extensions/nyatinorma.ts'),'--extension',controls,'--offline','--provider','nyatinorma-ollama','--model','test','--mode','rpc'],{cwd:app,env:{...process.env,PI_CODING_AGENT_DIR:join(data,'pi'),PI_OFFLINE:'1',NYATINORMA_DATA_DIR:data,NYATINORMA_MODEL:'test',NYATINORMA_OLLAMA_URL:`http://127.0.0.1:${(server.address() as any).port}`},stdio:'pipe'});
  let buffer='',errors='',serial=0,processError:Error|undefined;
  child.once('error',error=>processError=error);child.stdin!.on('error',error=>processError=error);
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stderr!.on('data',b=>errors+=b);child.stdout!.on('data',b=>{buffer+=b;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{events.push(JSON.parse(line));}catch{}}});
  const wait=async(fn:()=>any,timeout=10_000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(processError)throw processError;if(child!.exitCode!==null||child!.signalCode!==null)throw new Error(`RPC exited: ${child!.exitCode??child!.signalCode}; ${errors}`);const found=await fn();if(found)return found;await delay(25);}throw new Error('RPC timeout: '+errors+' '+JSON.stringify(events.slice(-5)));};
  const command=async(type:string,args:any={},timeout=10_000)=>{const id=String(++serial);child!.stdin!.write(JSON.stringify({type,id,...args})+'\n');const result=await wait(()=>events.find(e=>e.type==='response'&&e.id===id),timeout);assert.equal(result.success,true,JSON.stringify(result));return result.data;};
  const idle=()=>wait(async()=>{const state=await command('get_state');return !state.isStreaming&&!state.isCompacting&&state.pendingMessageCount===0?state:undefined;});
  const say=async(message:string)=>{await idle();const start=events.length;await command('prompt',{message});await wait(()=>events.slice(start).some(e=>e.type==='agent_settled'));await idle();assert.deepEqual(events.filter(e=>e.type==='extension_error'),[]);};
  const manage=async(message:string)=>{await idle();const before=requests.length;await command('prompt',{message});await idle();assert.equal(requests.length,before,'Reload must not be sent to the provider');assert.deepEqual(events.filter(e=>e.type==='extension_error'),[]);};
  // Readiness is an RPC response, not a fixed startup sleep or normal-turn deadline.
  await command('get_state',{},45_000);
  next={function:{name:'ny_tools',arguments:{operation:'enable',group:'legacy'}}};
  await say('Enable legacy tools for this isolated validation.');
  const action=async()=>{
    next={function:{name:'ny_drag',arguments:{snapshotId:'1790000000000-1234abcd',label:'test',intent:'test',point:{x:.5,y:.5},to:{x:.2,y:.5},anchor:{x:.1,y:.1,width:.1,height:.1},expectation:'test'}}};
    await say('Exercise the local action guard; do not capture or send input.');
    const messages=(await command('get_messages')).messages;
    const result=messages.findLast((m:any)=>m.role==='toolResult'&&m.toolName==='ny_drag');
    assert.ok(result);assert.equal(result.isError,true);return JSON.stringify(result.content);
  };
  assert.match(await action(),/fixture_action_v1/);
  // Add an export in the already-loaded runtime and make the action guard use it.
  await writeFile(path,current+'\nexport function actionRevision(){throw new Error("fixture_action_v2")}\n');
  await writeFile(guardPath,'import {actionRevision} from "./runtime.js";export function assertCanExecute(){actionRevision()}');
  await manage('/fixture-reload');
  next={function:{name:'ny_tools',arguments:{operation:'enable',group:'legacy'}}};
  await say('Enable legacy tools again after reload.');
  const refreshed=await action();assert.match(refreshed,/fixture_action_v2/);assert.doesNotMatch(refreshed,/fixture_action_v1/);
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
  server.closeAllConnections();const closed=once(server,'close');server.close();await closed;await rm(dir,{recursive:true,force:true});
 }
});
