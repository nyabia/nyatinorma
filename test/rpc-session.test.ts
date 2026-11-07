// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,cp,symlink,rm,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';

test('real pi RPC creates anonymous records without a model call and preserves named records across resume and fork', {timeout:90_000},async()=>{
  const scratch=resolve(import.meta.dirname,'../.tmpdl');await mkdir(scratch,{recursive:true});
  const dir=await mkdtemp(join(scratch,'ny-rpc-')),root=resolve(import.meta.dirname,'..'),app=join(dir,'app'),payloads:any[]=[],events:any[]=[],nextCalls:any[]=[];
  await cp(join(root,'src'),join(app,'src'),{recursive:true});await cp(join(root,'extensions'),join(app,'extensions'),{recursive:true});
  await writeFile(join(app,'package.json'),'{"type":"module"}');await symlink(join(root,'node_modules'),join(app,'node_modules'),process.platform==='win32'?'junction':'dir');
  await mkdir(join(dir,'pi'),{recursive:true});await writeFile(join(dir,'pi/settings.json'),JSON.stringify({quietStartup:true,retry:{enabled:false},compaction:{enabled:false}}));
  const skillDir=join(dir,'pi','skills','skill-access');await mkdir(skillDir,{recursive:true});
  const skillPath=join(skillDir,'SKILL.md');
  await writeFile(skillPath,'---\nname: skill-access\ndescription: Read-only skill access regression fixture.\n---\nSKILL_BODY_PROOF_49A: use fresh evidence, not saved coordinates.\n');
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;payloads.push(JSON.parse(body));const call=nextCalls.shift();res.setHeader('content-type','application/x-ndjson');res.end(JSON.stringify({message:{role:'assistant',content:call?'':'대화 확인',...(call?{tool_calls:Array.isArray(call)?call:[call]}:{})},done:true,prompt_eval_count:10,eval_count:3})+'\n');});
  const listening=once(server,'listening');server.listen(0,'127.0.0.1');await listening;
  const address=server.address();if(!address||typeof address==='string')throw new Error('Missing fixture server address');
  const child=spawn(process.execPath,[join(root,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),'--no-builtin-tools','--no-extensions','--no-context-files','--no-prompt-templates','--extension',join(app,'extensions/nyatinorma.ts'),'--offline','--provider','nyatinorma-ollama','--model','test-vision-model','--mode','rpc'],{cwd:app,env:{...process.env,PI_CODING_AGENT_DIR:join(dir,'pi'),PI_OFFLINE:'1',NYATINORMA_DATA_DIR:dir,NYATINORMA_MODEL:'test-vision-model',NYATINORMA_OLLAMA_URL:`http://127.0.0.1:${address.port}`},stdio:'pipe'});
  let buffer='',stderr='',serial=0,processError:Error|undefined;
  child.once('error',error=>processError=error);child.stdin.on('error',error=>processError=error);
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stderr.on('data',v=>{stderr+=v;});child.stdout.on('data',v=>{buffer+=v;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{events.push(JSON.parse(line));}catch{}}});
  const wait=async(predicate:()=>any,timeout=10_000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(processError)throw processError;if(child.exitCode!==null||child.signalCode!==null)throw new Error(`RPC exited: ${child.exitCode??child.signalCode}; ${stderr}`);const value=await predicate();if(value)return value;await delay(20);}throw new Error(`RPC timeout: ${stderr}\n${JSON.stringify(events.slice(-5))}`);};
  const request=async(type:string,rest:Record<string,unknown>={},timeout=10_000)=>{const id=String(++serial);child.stdin.write(JSON.stringify({id,type,...rest})+'\n');const r=await wait(()=>events.find(e=>e.type==='response'&&e.id===id),timeout);assert.equal(r.success,true,JSON.stringify(r));return r.data;};
  const idle=()=>wait(async()=>{const state=await request('get_state');return !state.isStreaming&&!state.isCompacting&&state.pendingMessageCount===0?state:undefined;});
  const say=async(message:string)=>{await idle();const start=events.length;await request('prompt',{message});await wait(()=>events.slice(start).find(e=>e.type==='agent_settled'));await idle();assert.deepEqual(events.filter(e=>e.type==='extension_error'),[]);};
  const manage=async(type:string,rest:Record<string,unknown>={})=>{await idle();const before=payloads.length,result=await request(type,rest);await idle();assert.equal(payloads.length,before,'Session management must not call the provider');assert.deepEqual(events.filter(e=>e.type==='extension_error'),[]);return result;};
  const state=()=>{const runtime=payloads.at(-1).messages.findLast((m:any)=>typeof m.content==='string'&&m.content.startsWith('[Runtime working state;'));return JSON.parse(runtime.content.slice(runtime.content.indexOf('\n')+1));};
  try{
    await request('get_state',{},45_000);
    await say('안녕. 게임은 조작하지 마.');assert.equal(state().run.anonymous,true);const anonymous=state().run.id;
    const tools=payloads.at(-1).tools as {function:{name:string}}[];
    assert.ok(tools.some(tool=>tool.function.name==='read'),'Skill files must be readable');
    assert.ok(!tools.some(tool=>['bash','powershell','edit','write'].includes(tool.function.name)),'Skill access must not enable shell or file mutation');
    assert.match(JSON.stringify(payloads.at(-1).messages),/skill-access/,'Skill discovery must survive the agent prompt customization');
    nextCalls.push({function:{name:'read',arguments:{path:skillPath}}});
    await say('skill-access 스킬 본문만 읽으세요. 게임은 조작하지 마세요.');
    assert.match(JSON.stringify(payloads.at(-1).messages),/SKILL_BODY_PROOF_49A/,'The actual skill contents must reach the model through read');
    await manage('prompt',{message:'/save 내 테스트 기록'});
    await say('저장한 기록 이름만 확인해. 게임 조작하지 마.');const first=state().run;assert.equal(first.id,anonymous);assert.equal(first.title,'내 테스트 기록');assert.equal(first.anonymous,false);
    const old=await request('get_state');assert.ok(old.sessionFile);
    await manage('new_session');await say('새 대화 확인. 작업 시작하지 마.');assert.equal(state().run.anonymous,true);assert.notEqual(state().run.id,first.id);const second=state().run.id;
    await manage('switch_session',{sessionPath:old.sessionFile});await say('재개한 대화의 연결만 확인. 게임은 건드리지 마.');assert.equal(state().run.id,first.id);
    const forkMessages=await request('get_fork_messages');await manage('fork',{entryId:forkMessages.messages.at(-1).entryId});
    await say('분기한 대화 확인. 이전 실행은 연결하지 마.');assert.equal(state().run.anonymous,true);assert.notEqual(state().run.id,first.id);assert.notEqual(state().run.id,second);
    await manage('switch_session',{sessionPath:old.sessionFile});
    nextCalls.push({function:{name:'ny_tools',arguments:{operation:'enable',group:'manage'}}});
    await say('프리셋 관리 도구만 불러와. 게임은 조작하지 마.');

    const pendingRun=state().run.id,pendingPath=join(dir,'runs',pendingRun,'execution-continuation.json');
    await writeFile(pendingPath,JSON.stringify({schemaVersion:1,id:'00000000-0000-4000-8000-000000000000',runId:pendingRun,lastInput:{delivery:'sent',outcome:'unresolved'}}));
    nextCalls.push({function:{name:'ny_run',arguments:{operation:'detach'}}});
    await say('미확정 입력이 있는 기록의 전환 차단 시험. 게임 입력은 하지 마.');assert.equal(state().run.id,pendingRun);
    await rm(pendingPath);

    const blockedId=state().run.id,runFile=join(dir,'runs',blockedId,'run.json'),callsBeforeBlock=payloads.length;
    nextCalls.push([
      {function:{name:'ny_block',arguments:{reason:'외부 승인이 필요함',attempts:['현재 권한 확인'],needed:'사용자가 승인한 뒤 재개',progress:'목록 관측까지 완료'}}},
      {function:{name:'ny_run',arguments:{operation:'start',title:'Should never be created'}}},
    ]);
    await say('진행 불가 종료 도구 시험. 외부 승인이 필요한 상황으로 중단해.');
    assert.equal(payloads.length,callsBeforeBlock+1,'blocking must not trigger another model request');
    const blocked=JSON.parse(await readFile(runFile,'utf8'));
    assert.equal(blocked.status,'blocked');assert.equal(blocked.blocked.needed,'사용자가 승인한 뒤 재개');
    const messages=(await request('get_messages')).messages;
    assert.ok(messages.some((m:any)=>m.role==='toolResult'&&m.toolName==='ny_block'&&m.content.some((c:any)=>c.text?.includes('외부 승인이 필요함'))));
    await say('/play 외부 승인 완료. 실제 입력 없이 재개 상태만 확인해.');
    assert.equal(state().run.status,'ready');assert.equal(state().run.blocked,undefined,'Resolved block reports must not be injected as current blockers');assert.ok(JSON.parse(await readFile(runFile,'utf8')).blocked.resumedAt,'The historical report remains on disk');assert.equal(state().run.id,blockedId);
    const inputTools:Record<string,true>={ny_act:true,ny_scroll:true,ny_drag:true,ny_run_select:true,ny_execute_flow:true,ny_locate:true};
    assert.ok(events.some(e=>e.type==='tool_execution_start'),'The RPC fixture must actually exercise tools');
    assert.deepEqual(events.filter(e=>e.type==='tool_execution_start'&&inputTools[e.toolName]),[],'Metadata/session RPC exercises must not invoke input tools');

  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}server.closeAllConnections();const closed=once(server,'close');server.close();await closed;await rm(dir,{recursive:true,force:true});}
});
