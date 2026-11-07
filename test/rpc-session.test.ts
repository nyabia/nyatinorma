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
  // Built-in TUI /reload is ordinary model input in RPC. Use the real command API.
  const controls=join(app,'extensions/rpc-controls.ts');
  await writeFile(controls,'export default function(pi){pi.registerCommand("fixture-reload",{handler:async(_args,ctx)=>{await ctx.waitForIdle();await ctx.reload();}})}');
  await mkdir(join(dir,'pi'),{recursive:true});await writeFile(join(dir,'pi/settings.json'),JSON.stringify({quietStartup:true,retry:{enabled:false},compaction:{enabled:false}}));
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;payloads.push(JSON.parse(body));const call=nextCalls.shift();res.setHeader('content-type','application/x-ndjson');res.end(JSON.stringify({message:{role:'assistant',content:call?'':'대화 확인',...(call?{tool_calls:Array.isArray(call)?call:[call]}:{})},done:true,prompt_eval_count:10,eval_count:3})+'\n');});
  const listening=once(server,'listening');server.listen(0,'127.0.0.1');await listening;
  const child=spawn(process.execPath,[join(root,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),'--no-builtin-tools','--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--extension',join(app,'extensions/nyatinorma.ts'),'--extension',controls,'--offline','--provider','nyatinorma-ollama','--model','test-vision-model','--mode','rpc'],{cwd:app,env:{...process.env,PI_CODING_AGENT_DIR:join(dir,'pi'),PI_OFFLINE:'1',NYATINORMA_DATA_DIR:dir,NYATINORMA_MODEL:'test-vision-model',NYATINORMA_OLLAMA_URL:`http://127.0.0.1:${(server.address() as any).port}`},stdio:'pipe'});
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
    const commands=await request('get_commands');assert.ok(commands.commands.some((c:any)=>c.name==='preset'));
    await say('안녕. 게임은 조작하지 마.');assert.equal(state().run.anonymous,true);const anonymous=state().run.id;
    assert.equal(state().run.preset.id,'scratch');assert.deepEqual(state().knowledge.availableScenarios,[]);assert.equal(state().knowledge.scenario,null);
    const act=payloads.at(-1).tools.find((tool:any)=>tool.function?.name==='ny_act').function;
    assert.ok(act.parameters.properties.goal);assert.ok(act.parameters.properties.resume);assert.ok(act.parameters.properties.until);assert.equal(act.parameters.properties.point,undefined);
    assert.ok(!payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_preview'));
    assert.ok(payloads.at(-1).tools.every((tool:any)=>tool.function?.name.startsWith('ny_')),'Tool groups must not re-enable disabled coding tools');
    assert.ok(!payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_task'));
    assert.ok(payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_time'));
    nextCalls.push({function:{name:'ny_time',arguments:{operation:'set_deadline',nextLocalTime:'03:00'}}});
    await say('시간 도구 테스트: 다음 현지 03:00을 마감으로 저장하고 게임은 조작하지 마.');
    assert.ok(state().run.stopAt);assert.ok(Date.parse(state().run.stopAt)>Date.now());
    nextCalls.push({function:{name:'ny_time',arguments:{operation:'clear_deadline'}}});
    await say('테스트 마감을 해제하고 게임은 조작하지 마.');assert.equal(state().run.stopAt,null);
    assert.ok(!payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_drag'));
    assert.ok(payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_knowledge'));
    await manage('prompt',{message:'/save 내 테스트 기록'});
    await say('저장한 기록 이름만 확인해. 게임 조작하지 마.');const first=state().run;assert.equal(first.id,anonymous);assert.equal(first.title,'내 테스트 기록');assert.equal(first.anonymous,false);
    const old=await request('get_state');assert.ok(old.sessionFile);
    await manage('new_session');await say('새 대화 확인. 작업 시작하지 마.');assert.equal(state().run.anonymous,true);assert.notEqual(state().run.id,first.id);const second=state().run.id;
    await manage('switch_session',{sessionPath:old.sessionFile});await say('재개한 대화의 연결만 확인. 게임은 건드리지 마.');assert.equal(state().run.id,first.id);
    const forkMessages=await request('get_fork_messages');await manage('fork',{entryId:forkMessages.messages.at(-1).entryId});
    await say('분기한 대화 확인. 이전 실행은 연결하지 마.');assert.equal(state().run.anonymous,true);assert.notEqual(state().run.id,first.id);assert.notEqual(state().run.id,second);
    await manage('switch_session',{sessionPath:old.sessionFile});
    await manage('prompt',{message:'/chat'});await say('새 임시 기록 확인.');assert.equal(state().run.anonymous,true);assert.notEqual(state().run.id,first.id);
    nextCalls.push({function:{name:'ny_knowledge',arguments:{operation:'remember',scope:'app',title:'공통 앱 메모',content:'다음 대화에서도 참조할 지식',status:'hypothesis'}}});
    await say('앱 지식 저장 시험. 게임 입력은 하지 마.');assert.equal(state().knowledge.lessons.app[0].title,'공통 앱 메모');
    nextCalls.push({function:{name:'ny_knowledge',arguments:{operation:'remember',scope:'scenario',scenario:'theater',title:'극장 한정 메모',content:'다른 상황에는 주입하지 않을 지식',status:'hypothesis'}}});
    await say('상황 지식 저장 시험. 게임 입력은 하지 마.');assert.equal(state().knowledge.lessons.scenario.length,0);
    nextCalls.push({function:{name:'ny_knowledge',arguments:{operation:'use',scenario:'theater'}}});
    await say('극장 지식 선택 시험. 게임 입력은 하지 마.');assert.equal(state().knowledge.lessons.scenario[0].title,'극장 한정 메모');
    await manage('new_session');await say('새 대화 지식 확인만.');assert.equal(state().knowledge.scenario,null);assert.equal(state().knowledge.lessons.scenario.length,0);assert.equal(state().knowledge.lessons.app[0].title,'공통 앱 메모');
    nextCalls.push({function:{name:'ny_tools',arguments:{operation:'enable',group:'manage'}}});
    await say('프리셋 관리 도구만 불러와. 게임은 조작하지 마.');
    assert.ok(payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_task'));
    assert.ok(!payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_preview'));
    assert.ok(payloads.at(-1).tools.every((tool:any)=>tool.function?.name.startsWith('ny_')),'Tool groups must not re-enable disabled coding tools');
    const tool=(name:string)=>payloads.at(-1).tools.find((t:any)=>t.function.name===name).function;
    assert.ok(tool('ny_plan').parameters.properties.steps);
    assert.ok(tool('ny_checkpoint').parameters.properties.data);
    assert.doesNotMatch(payloads.at(-1).messages.find((m:any)=>m.role==='system').content,/trickcal-theater|select_story|select_season|start_battle/);
    nextCalls.push({function:{name:'ny_task',arguments:{operation:'save',id:'learned-navigation',name:'학습한 탐색 절차',objective:'관측한 목록 탐색',instructions:['현재 창부터 관측'],successCriteria:['요청한 항목 확인']}}});
    await say('실행 중 학습한 절차를 프리셋으로 저장하는 도구 시험.');assert.ok(state().knowledge.availableScenarios.some((s:any)=>s.id==='learned-navigation'));assert.equal(state().run.preset.id,'scratch');
    const snapshotId='1790000000000-1234abcd';await writeFile(join(dir,'captures',snapshotId+'.json'),JSON.stringify({id:snapshotId}));
    nextCalls.push({function:{name:'ny_checkpoint',arguments:{snapshotId,note:'임의 앱의 목록 확인',key:'list-a',data:{visibleItems:['a','b']},state:{page:'list'}}}});
    await say('범용 체크포인트 도구 시험. 입력은 하지 마.');assert.equal(state().state.page,'list');assert.deepEqual(state().recentCheckpoints[0][1].data,{visibleItems:['a','b']});

    const pendingRun=state().run.id,pendingPath=join(dir,'runs',pendingRun,'execution-continuation.json');
    await writeFile(pendingPath,JSON.stringify({schemaVersion:1,id:'00000000-0000-4000-8000-000000000000',runId:pendingRun,lastInput:{delivery:'sent',outcome:'unresolved'}}));
    nextCalls.push({function:{name:'ny_run',arguments:{operation:'detach'}}});
    await say('미확정 입력이 있는 기록의 전환 차단 시험. 게임 입력은 하지 마.');assert.equal(state().run.id,pendingRun);
    await rm(pendingPath);
    nextCalls.push({function:{name:'ny_time',arguments:{operation:'set_deadline',nextLocalTime:'03:00'}}});
    await say('Set a test deadline; no game input.');const cutoff=state().run.stopAt;
    nextCalls.push({function:{name:'ny_run',arguments:{operation:'start',title:'Deadline inheritance test'}}});
    await say('Create a separate test record while keeping the deadline.');assert.notEqual(state().run.id,pendingRun);assert.equal(state().run.stopAt,cutoff);

    const blockedId=state().run.id,runFile=join(dir,'runs',blockedId,'run.json'),callsBeforeBlock=payloads.length;
    nextCalls.push([
      {function:{name:'ny_block',arguments:{reason:'외부 승인이 필요함',attempts:['현재 권한 확인'],needed:'사용자가 승인한 뒤 재개',progress:'목록 관측까지 완료',snapshotId}}},
      {function:{name:'ny_run',arguments:{operation:'start',title:'Should never be created'}}},
    ]);
    await say('진행 불가 종료 도구 시험. 외부 승인이 필요한 상황으로 중단해.');
    assert.equal(payloads.length,callsBeforeBlock+1,'blocking must not trigger another model request');
    const blocked=JSON.parse(await readFile(runFile,'utf8'));
    assert.equal(blocked.status,'blocked');assert.equal(blocked.blocked.needed,'사용자가 승인한 뒤 재개');
    const messages=(await request('get_messages')).messages;
    assert.ok(messages.some((m:any)=>m.role==='toolResult'&&m.toolName==='ny_block'&&m.content.some((c:any)=>c.text?.includes('외부 승인이 필요함'))));
    await manage('prompt',{message:'/fixture-reload'});
    await say('왜 중단했는지 설명만 해. 재개하지 마.');assert.equal(state().run.id,blockedId);assert.equal(state().run.status,'blocked');
    nextCalls.push({function:{name:'ny_tools',arguments:{operation:'enable',group:'manage'}}});
    await say('Enable management tools for the blocked-state safety check; do not resume.');
    // Even an attempted model restart is blocked after reload, with no second request.
    nextCalls.push({function:{name:'ny_run',arguments:{operation:'start',title:'Bypass attempt'}}});
    const callsBeforeBypass=payloads.length;
    await say('도구 차단 시험. 새 실행으로 우회해서는 안 됨.');
    assert.equal(payloads.length,callsBeforeBypass+1);assert.equal(JSON.parse(await readFile(runFile,'utf8')).status,'blocked');
    await say('/play 외부 승인 완료. 실제 입력 없이 재개 상태만 확인해.');
    assert.equal(state().run.status,'ready');assert.equal(state().run.blocked,undefined,'Resolved block reports must not be injected as current blockers');assert.ok(JSON.parse(await readFile(runFile,'utf8')).blocked.resumedAt,'The historical report remains on disk');assert.equal(state().run.id,blockedId);
    const inputTools:Record<string,true>={ny_act:true,ny_scroll:true,ny_drag:true,ny_run_select:true,ny_execute_flow:true,ny_locate:true};
    assert.ok(events.some(e=>e.type==='tool_execution_start'),'The RPC fixture must actually exercise tools');
    assert.deepEqual(events.filter(e=>e.type==='tool_execution_start'&&inputTools[e.toolName]),[],'Metadata/session RPC exercises must not invoke input tools');

  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}server.closeAllConnections();const closed=once(server,'close');server.close();await closed;await rm(dir,{recursive:true,force:true});}
});
