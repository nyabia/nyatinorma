// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {directClick,type DirectClickInput} from '../src/direct-click.js';
import {dataDir,defaults} from '../src/config.js';
import {executionHost,withExecutionHost,type ExecutionHost} from '../src/host-context.js';
import {assertNoUnresolvedInput,loadContinuation,type Continuation} from '../src/execution-contract.js';
import {acquireInput} from '../src/input-lock.js';
import {runExecution} from '../src/execution-controller.js';
import {InputNotSentError} from '../src/input-error.js';
import {CuaTimeoutError} from '../src/cua-transport.js';
import type {Decision,Snapshot} from '../src/types.js';

const request={snapshotId:'source',label:'줄무늬 버튼',intent:'버튼을 눌러 상세 화면 열기',point:{x:.375,y:.5}};
const work={revision:'direct-click',requests:['버튼을 한 번 누른 뒤 결과를 확인한다.']};
const decision=(choice:string):Decision=>({choice,legalMass:1,margin:1,truncated:false,probabilities:{[choice]:1},reason:'test',elapsedMs:0});
async function fixture(body:(screens:Snapshot[])=>Promise<void>){
  await mkdir(join(dataDir,'test-tmp'),{recursive:true});
  const dir=await mkdtemp(join(dataDir,'test-tmp','ny-direct-click-'));
  try{
    const screens:Snapshot[]=[];
    for(const variant of ['source','animated','changed-target','after']){
      const path=join(dir,variant+'.png');
      const target=variant==='changed-target'?'#000':'url(#stripes)';
      await sharp(Buffer.from(`<svg width="400" height="300"><defs><pattern id="stripes" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="white"/><rect width="8" height="16" fill="black"/></pattern></defs><rect width="400" height="300" fill="#888"/><rect width="160" height="60" fill="url(#stripes)"/><rect x="100" y="120" width="100" height="60" fill="${target}"/><rect x="300" y="230" width="100" height="70" fill="${variant==='animated'?'white':'black'}"/></svg>`)).png().toFile(path);
      screens.push({id:variant,path,width:400,height:300,at:Date.now(),ocr:[],window:{pid:1,windowId:2,title:'테스트',frame:{x:20,y:30,width:400,height:300}}});
    }
    const values=new Map<string,Continuation>();let latest:string|undefined;
    const host:ExecutionHost={id:randomUUID(),inputScope:randomUUID(),config:async()=>({...defaults}),snapshot:async id=>screens.find(s=>s.id===id),loadContinuation:async id=>structuredClone(values.get(id??latest??'')),saveContinuation:async value=>{values.set(value.id,structuredClone(value));latest=value.id;}};
    await withExecutionHost(host,()=>body(screens));
  }finally{await rm(dir,{recursive:true,force:true});}
}

test('직접 클릭은 주변 애니메이션을 허용하고 잠금·저널 안에서 한 번 전송한 뒤 화면만 돌려준다',async()=>fixture(async screens=>{
  let captures=0,inputs=0;
  const r=await directClick(request,undefined,{
    capture:async()=>{assert.throws(()=>acquireInput(),/already active/);return screens[++captures===1?1:3];},
    execute:async(action,s)=>{
      inputs++;assert.equal(captures,1);assert.equal(s.id,'animated');assert.equal(action.kind,'click');
      assert.ok(Math.abs(action.box!.x+action.box!.width/2-request.point.x)<1e-12);
      assert.ok(Math.abs(action.box!.y+action.box!.height/2-request.point.y)<1e-12);
      const j=await loadContinuation();assert.equal(j?.lastInput.delivery,'unknown');assert.equal(j?.lastInput.outcome,'unresolved');
      await assert.rejects(assertNoUnresolvedInput(),/unresolved/);return {};
    },
  });
  assert.equal(inputs,1);assert.equal(captures,2);assert.equal(r.inputSent,true);assert.equal(r.snapshot.id,'after');
  assert.equal(r.reason,'input_dispatched');assert.equal(r.selectCalls,0);assert.equal(r.lastInput.delivery,'sent');assert.equal(r.lastInput.outcome,'observed');
  assert.equal(r.lastInput.beforeSnapshotId,'animated');assert.equal(r.lastInput.afterSnapshotId,'after');
  assert.equal(r.continuationId,undefined);await assertNoUnresolvedInput();
  const release=acquireInput();release();
}));


test('바뀐 창과 변경된 대상은 입력 전에 거절하고 최신 이미지를 반환한다',async()=>fixture(async screens=>{
  const source=screens[0];
  const changes=[
    {...source,id:'pid',window:{...source.window,pid:8}},
    screens[2],
  ];
  for(const current of changes){
    let inputs=0;
    const r=await directClick(request,undefined,{capture:async()=>current,execute:async()=>{inputs++;}});
    assert.equal(inputs,0);assert.equal(r.inputSent,false);assert.equal(r.snapshot,current);
    assert.equal(r.reason,current===screens[2]?'target_changed':'window_changed');await assertNoUnresolvedInput();
  }
}));


test('잘못된 좌표와 중복 대상은 실행하지 않는다',async()=>fixture(async screens=>{
  let inputs=0,captures=0;
  const deps={capture:async()=>{captures++;return screens[0];},execute:async()=>{inputs++;}};
  const invalid:DirectClickInput[]=[
    {...request,point:{x:1,y:.5}},
    {...request,box:{x:0,y:0,width:.2,height:.2}},
  ];
  for(const input of invalid)await assert.rejects(directClick(input,undefined,deps));
  assert.equal(inputs,0);assert.equal(captures,0);await assertNoUnresolvedInput();
}));


test('준비된 저널 뒤 취소되면 미전송으로 기록하고 잠금을 해제한다',async()=>fixture(async screens=>{
  const abort=new AbortController(),host=executionHost()!;let inputs=0;
  const r=await withExecutionHost({...host,saveContinuation:async value=>{
    await host.saveContinuation(value);
    if(value.lastInput.outcome==='unresolved')abort.abort();
  }},()=>directClick(request,abort.signal,{capture:async()=>screens[0],execute:async()=>{inputs++;}}));
  assert.equal(inputs,0);assert.equal(r.inputSent,false);assert.equal(r.lastInput.delivery,'not_sent');await assertNoUnresolvedInput();
}));

test('드라이버의 명시적 거절은 미전송이며 자동 재시도하지 않는다',async()=>fixture(async screens=>{
  let inputs=0;
  const r=await directClick(request,undefined,{capture:async()=>screens[0],execute:async()=>{inputs++;throw new InputNotSentError('창 변경');}});
  assert.equal(inputs,1);assert.equal(r.inputSent,false);assert.equal(r.reason,'input_not_sent');await assertNoUnresolvedInput();
}));

test('불명확한 전송은 새 이미지가 있어도 재시도하지 않으며 기존 resume이 관찰만으로 복구한다',async()=>fixture(async screens=>{
  let inputs=0,captures=0;
  const r=await directClick(request,undefined,{capture:async()=>screens[++captures===1?0:3],execute:async()=>{inputs++;throw new CuaTimeoutError('click');}});
  assert.equal(r.inputSent,null);assert.equal(r.reason,'input_outcome_unknown');assert.equal(r.snapshot.id,'after');
  assert.equal(r.lastInput.delivery,'unknown');assert.equal(r.lastInput.outcome,'unresolved');assert.ok(r.continuationId);assert.equal(inputs,1);
  await assert.rejects(directClick(request,undefined,{capture:async()=>screens[0],execute:async()=>{inputs++;}}),/unresolved/);
  let reconciliations=0;
  const resumed=await runExecution({resume:r.continuationId},async()=>({description:'관찰 완료',actions:[]}),work,{}, {
    capture:async()=>screens[3],trace:async()=>{},sleep:async()=>{},execute:async()=>{throw new Error('재전송 금지');},
    choose:async(_prompt,choices)=>{if(choices.some(c=>c.id==='observed')){reconciliations++;assert.ok(!choices.some(c=>c.id==='no_effect'));return decision('observed');}return decision('stop');},
  });
  assert.equal(reconciliations,1);assert.equal(resumed.lastInput.outcome,'observed');assert.equal(inputs,1);await assertNoUnresolvedInput();
}));

