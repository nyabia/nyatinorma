// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('real pi RPC creates anonymous records without a model call and preserves named records across resume and fork', {timeout:35_000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-rpc-')),payloads:any[]=[],events:any[]=[],nextCalls:any[]=[];
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;payloads.push(JSON.parse(body));const call=nextCalls.shift();res.setHeader('content-type','application/x-ndjson');res.end(JSON.stringify({message:{role:'assistant',content:call?'':'대화 확인',...(call?{tool_calls:Array.isArray(call)?call:[call]}:{})},done:true,prompt_eval_count:10,eval_count:3})+'\n');});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const child=spawn(process.execPath,['--import','tsx','src/cli.ts','tui','--mode','rpc'],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,NYATINORMA_DATA_DIR:dir,NYATINORMA_MODEL:"test-vision-model",NYATINORMA_OLLAMA_URL:`http://127.0.0.1:${(server.address() as any).port}`},stdio:'pipe'});
  let buffer='',stderr='',serial=0;child.stderr.on('data',v=>{stderr+=v;});child.stdout.on('data',v=>{buffer+=v;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{events.push(JSON.parse(line));}catch{}}});
  const wait=async(predicate:()=>any)=>{const end=Date.now()+8000;while(Date.now()<end){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw new Error(`RPC timeout: ${stderr}\n${JSON.stringify(events.slice(-4))}`);};
  const request=async(type:string,rest:Record<string,unknown>={})=>{const id=String(++serial);child.stdin.write(JSON.stringify({id,type,...rest})+'\n');const r=await wait(()=>events.find(e=>e.type==='response'&&e.id===id));assert.equal(r.success,true,JSON.stringify(r));return r.data;};
  const say=async(message:string)=>{const start=events.length;await request('prompt',{message});await wait(()=>events.slice(start).find(e=>e.type==='agent_settled'));};
  const state=()=>{const runtime=payloads.at(-1).messages.findLast((m:any)=>typeof m.content==='string'&&m.content.startsWith('[Runtime working state;'));return JSON.parse(runtime.content.slice(runtime.content.indexOf('\n')+1));};
  try{
    const commands=await request('get_commands');assert.ok(commands.commands.some((c:any)=>c.name==='preset'));
    await say('안녕. 게임은 조작하지 마.');assert.equal(state().run.anonymous,true);const anonymous=state().run.id;
    assert.equal(state().run.preset.id,'scratch');assert.deepEqual(state().knowledge.availableScenarios,[]);assert.equal(state().knowledge.scenario,null);
    assert.ok(payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_drag'));
    const act=payloads.at(-1).tools.find((tool:any)=>tool.function?.name==='ny_act').function;
    assert.ok(act.parameters.properties.goal);assert.equal(act.parameters.properties.point,undefined);
    assert.ok(!payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_preview'));
    assert.ok(!payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_task'));
    assert.ok(payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_time'));
    nextCalls.push({function:{name:'ny_time',arguments:{operation:'set_deadline',nextLocalTime:'03:00'}}});
    await say('시간 도구 테스트: 다음 현지 03:00을 마감으로 저장하고 게임은 조작하지 마.');
    assert.ok(state().run.stopAt);assert.ok(Date.parse(state().run.stopAt)>Date.now());
    nextCalls.push({function:{name:'ny_time',arguments:{operation:'clear_deadline'}}});
    await say('테스트 마감을 해제하고 게임은 조작하지 마.');assert.equal(state().run.stopAt,null);
    assert.ok(payloads.at(-1).tools.find((tool:any)=>tool.function?.name==='ny_drag').function.parameters.properties.gridPoint);
    assert.ok(payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_knowledge'));
    await request('prompt',{message:'/save 내 테스트 기록'});
    await say('저장한 기록 이름만 확인해. 게임 조작하지 마.');const first=state().run;assert.equal(first.id,anonymous);assert.equal(first.title,'내 테스트 기록');assert.equal(first.anonymous,false);
    const old=await request('get_state');assert.ok(old.sessionFile);
    await request('new_session');await say('새 대화 확인. 작업 시작하지 마.');assert.equal(state().run.anonymous,true);assert.notEqual(state().run.id,first.id);const second=state().run.id;
    await request('switch_session',{sessionPath:old.sessionFile});await say('재개한 대화의 연결만 확인. 게임은 건드리지 마.');assert.equal(state().run.id,first.id);
    const forkMessages=await request('get_fork_messages');await request('fork',{entryId:forkMessages.messages.at(-1).entryId});
    await say('분기한 대화 확인. 이전 실행은 연결하지 마.');assert.equal(state().run.anonymous,true);assert.notEqual(state().run.id,first.id);assert.notEqual(state().run.id,second);
    await request('switch_session',{sessionPath:old.sessionFile});
    await request('prompt',{message:'/chat'});await say('새 임시 기록 확인.');assert.equal(state().run.anonymous,true);assert.notEqual(state().run.id,first.id);
    assert.equal(payloads.length,10); // Six greetings plus two clock tool turns (two requests each); management commands add none.
    nextCalls.push({function:{name:'ny_knowledge',arguments:{operation:'remember',scope:'app',title:'공통 앱 메모',content:'다음 대화에서도 참조할 지식',status:'hypothesis'}}});
    await say('앱 지식 저장 시험. 게임 입력은 하지 마.');assert.equal(state().knowledge.lessons.app[0].title,'공통 앱 메모');
    nextCalls.push({function:{name:'ny_knowledge',arguments:{operation:'remember',scope:'scenario',scenario:'theater',title:'극장 한정 메모',content:'다른 상황에는 주입하지 않을 지식',status:'hypothesis'}}});
    await say('상황 지식 저장 시험. 게임 입력은 하지 마.');assert.equal(state().knowledge.lessons.scenario.length,0);
    nextCalls.push({function:{name:'ny_knowledge',arguments:{operation:'use',scenario:'theater'}}});
    await say('극장 지식 선택 시험. 게임 입력은 하지 마.');assert.equal(state().knowledge.lessons.scenario[0].title,'극장 한정 메모');
    await request('new_session');await say('새 대화 지식 확인만.');assert.equal(state().knowledge.scenario,null);assert.equal(state().knowledge.lessons.scenario.length,0);assert.equal(state().knowledge.lessons.app[0].title,'공통 앱 메모');
    assert.equal(payloads.length,17);
    nextCalls.push({function:{name:'ny_tools',arguments:{operation:'enable',group:'manage'}}});
    await say('프리셋 관리 도구만 불러와. 게임은 조작하지 마.');
    assert.ok(payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_task'));
    assert.ok(!payloads.at(-1).tools.some((tool:any)=>tool.function?.name==='ny_preview'));
    const tool=(name:string)=>payloads.at(-1).tools.find((t:any)=>t.function.name===name).function;
    assert.equal(tool('ny_drag').parameters.properties.intent.enum,undefined);
    assert.equal(tool('ny_drag').parameters.properties.stars,undefined);
    assert.ok(tool('ny_checkpoint').parameters.properties.data);
    assert.doesNotMatch(payloads.at(-1).messages.find((m:any)=>m.role==='system').content,/trickcal-theater|select_story|select_season|start_battle/);
    nextCalls.push({function:{name:'ny_task',arguments:{operation:'save',id:'learned-navigation',name:'학습한 탐색 절차',objective:'관측한 목록 탐색',instructions:['현재 창부터 관측'],successCriteria:['요청한 항목 확인']}}});
    await say('실행 중 학습한 절차를 프리셋으로 저장하는 도구 시험.');assert.ok(state().knowledge.availableScenarios.some((s:any)=>s.id==='learned-navigation'));assert.equal(state().run.preset.id,'scratch');
    const snapshotId='1790000000000-1234abcd';await writeFile(join(dir,'captures',snapshotId+'.json'),JSON.stringify({id:snapshotId}));
    nextCalls.push({function:{name:'ny_checkpoint',arguments:{snapshotId,note:'임의 앱의 목록 확인',key:'list-a',data:{visibleItems:['a','b']},state:{page:'list'}}}});
    await say('범용 체크포인트 도구 시험. 입력은 하지 마.');assert.equal(state().state.page,'list');assert.deepEqual(state().recentCheckpoints[0][1].data,{visibleItems:['a','b']});

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
    await request('prompt',{message:'/reload'});
    await say('왜 중단했는지 설명만 해. 재개하지 마.');assert.equal(state().run.id,blockedId);assert.equal(state().run.status,'blocked');
    // Even an attempted model restart is blocked after reload, with no second request.
    nextCalls.push({function:{name:'ny_run',arguments:{operation:'start',title:'Bypass attempt'}}});
    const callsBeforeBypass=payloads.length;
    await say('도구 차단 시험. 새 실행으로 우회해서는 안 됨.');
    assert.equal(payloads.length,callsBeforeBypass+1);assert.equal(JSON.parse(await readFile(runFile,'utf8')).status,'blocked');
    const startResume=events.length;
    await request('prompt',{message:'/play 외부 승인 완료. 실제 입력 없이 재개 상태만 확인해.'});
    await wait(()=>events.slice(startResume).find(e=>e.type==='agent_settled'));
    assert.equal(state().run.status,'ready');assert.ok(state().run.blocked.resumedAt);assert.equal(state().run.id,blockedId);

  }finally{child.kill('SIGTERM');await new Promise<void>(r=>{if(child.exitCode!==null)r();else child.once('exit',()=>r());});server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
