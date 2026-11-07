// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {dataDir,defaults} from '../src/config.js';
import {runAct} from '../src/adaptive-act.js';
import {runExecution} from '../src/execution-controller.js';
import {performAction,type ActionDeps} from '../src/action-runtime.js';
import {CuaTimeoutError} from '../src/cua-transport.js';
import {runFlow,type Flow} from '../src/flow.js';
import {fingerprint} from '../src/vision.js';
import type {Snapshot,Decision} from '../src/types.js';
import {withExecutionHost,type ExecutionHost} from '../src/host-context.js';
import type {Continuation} from '../src/execution-contract.js';
import {snapshot} from '../src/store.js';
import {addActPoint,projectActPoint,renderActPointOverlay} from '../src/act-points.js';
import {actionArgs} from '../src/desktop.js';

const yes=(choice:string):Decision=>({choice,legalMass:1,margin:.9,truncated:false,probabilities:{[choice]:1},reason:'test',elapsedMs:1});
const contract={revision:'test',requests:['Find the requested item, open it, then stop.']};
async function fixture(body:(screens:Snapshot[],host:ExecutionHost)=>Promise<void>){
  await mkdir(join(dataDir,'test-tmp'),{recursive:true});
  const dir=await mkdtemp(join(dataDir,'test-tmp','ny-act-'));
  try{
    const screens:Snapshot[]=[];
    for(let i=0;i<4;i++){
      const path=join(dir,`${i}.png`);
      await sharp(Buffer.from(`<svg width="240" height="180"><rect width="240" height="180" fill="rgb(${40+i*40},${40+i*40},${40+i*40})"/><rect width="50" height="30" fill="white"/><rect x="90" y="65" width="60" height="50" fill="blue"/></svg>`)).png().toFile(path);
      screens.push({id:String(i),path,width:240,height:180,at:Date.now(),ocr:[],window:{pid:1,windowId:2,title:'Test',frame:{x:0,y:0,width:240,height:180}}});
    }
    const continuations=new Map<string,Continuation>();let active:string|undefined;
    const host:ExecutionHost={id:randomUUID(),inputScope:randomUUID(),actPointDirectory:join(dir,'act-points'),config:async()=>({...defaults}),loadContinuation:async(id)=>structuredClone(continuations.get(id??active??'')),saveContinuation:async(value)=>{continuations.set(value.id,structuredClone(value));active=value.id;},snapshot:async(id)=>screens.find(s=>s.id===id)??snapshot(id).catch(()=>undefined)};
    await withExecutionHost(host,()=>body(screens,host));
  }finally{await rm(dir,{recursive:true,force:true});}
}

test('ACT reuses generated drag candidates, adapts to a new screen and locates a click without parent turns',async()=>fixture(async(screens)=>{
  let index=0,generated=0,inputs=0;
  const result=await runAct({grid_navigation:true,goal:'Find and open item',doneWhen:'Details visible'},contract,{}, {
    capture:async()=>screens[index],sleep:async()=>{},trace:async()=>{},
    generate:async()=>{generated++;return JSON.stringify(generated===1?{description:'List',actions:[{id:'scroll',kind:'drag',surface:'list',regionPath:['C3'],direction:'up',when:'Item absent',expectation:'More items visible'}]}:{description:'Item visible',actions:[{id:'open',kind:'click',target:'blue item button',when:'Item visible',expectation:'Details visible'}]});},
    choose:async(prompt,choices)=>{
      if(choices[0].id==='yes'){
        if(prompt.includes('Completion check')&&index<3)return yes('no');
        return yes('yes');
      }
      if(choices.some(c=>c.id==='moved'))return yes(index>=2?'found':'moved');
      if(choices.some(c=>c.id==='scroll'))return yes(index<2?'scroll':'rebuild');
      return yes(index===3?'done':'open');
    },
    execute:async action=>{inputs++;if(action.kind==='click'){assert.equal(index,2);assert.ok(Math.abs(action.box!.x+action.box!.width/2-.5)<.001);}index++;return {focusPreserved:true};},
  });
  assert.equal(result.reason,'local_goal_observed',result.error);assert.equal(result.actions,3);assert.equal(inputs,3);assert.equal(generated,2);
}));

test('ACT never repeats a click whose expected result is unconfirmed; cancellation before dispatch also stops input',async()=>fixture(async(screens)=>{
  for(const cancel of [true,false]){
    const controller=new AbortController();let inputs=0;
    const result=await runAct({grid_navigation:true,goal:'Open button',doneWhen:'Details visible'},contract,{signal:controller.signal},{capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},generate:async()=>JSON.stringify({description:'Button',actions:[{id:'open',kind:'click',target:'blue button',when:'Visible',expectation:'Details visible'}]}),choose:async(prompt,choices)=>{
      if(choices.some(c=>c.id==='open')){if(cancel)controller.abort();return yes('open');}
      if(prompt.includes('A click on'))return yes('no');
      return yes('yes');
    },execute:async()=>{inputs++;return {};}});
    assert.equal(inputs,cancel?0:1);assert.equal(result.reason,cancel?'cancelled':'outcome_unconfirmed');
  }
}));


test('ACT journals an unknown dispatch and resume observes without replay',async()=>fixture(async(screens)=>{
  let inputs=0,generations=0;
  const deps={capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},
    generate:async()=>JSON.stringify(++generations===1?{description:'Button',actions:[{id:'open',kind:'click',target:'blue button',when:'Visible',expectation:'Details visible'}]}:{description:'Details',actions:[]}),
    choose:async(_prompt:string,choices:{id:string}[])=>{
      if(choices.some(c=>c.id==='observed')){assert.ok(!choices.some(c=>c.id==='no_effect'),'unknown delivery cannot be reconciled as no effect');return yes('observed');}
      if(choices.some(c=>c.id==='open'))return yes('open');
      if(choices.some(c=>c.id==='done'))return yes('done');
      return yes('yes');
    },execute:async()=>{inputs++;throw new CuaTimeoutError('click');}};
  const first=await runAct({grid_navigation:true,goal:'Open button',until:'Details visible'},contract,{},deps);
  assert.equal(first.reason,'input_outcome_unknown');assert.equal(first.lastInput.delivery,'unknown');assert.equal(first.lastInput.outcome,'unresolved');assert.ok(first.continuationId);
  const resumed=await runAct({resume:first.continuationId},contract,{},deps);
  assert.equal(resumed.reason,'local_goal_observed',resumed.error);assert.equal(resumed.lastInput.outcome,'observed');assert.equal(inputs,1);
}));


test('a passive wait remains input-free when resumed through ACT',async()=>fixture(async(screens)=>{
  let phase=0,generated=0,inputs=0;
  const choose=async(_prompt:string,choices:{id:string}[])=>yes(choices.some(c=>c.id==='done')?(phase++===0?'wait':'done'):'yes');
  const first=await runExecution({goal:'Wait for ready',until:'Ready',mode:'wait'},async()=>({description:'Waiting',actions:[{id:'click',kind:'click',label:'button',target:'button',when:'Visible',expectation:'Clicked'}]}),contract,{maxWaits:0},{capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},choose,execute:async()=>{inputs++;return {};}});
  assert.equal(first.reason,'wait_budget');assert.ok(first.continuationId);
  const resumed=await runAct({resume:first.continuationId},contract,{}, {capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},choose,execute:async()=>{inputs++;return {};},generate:async()=>{generated++;return '{}';}});
  assert.equal(resumed.reason,'local_goal_observed',resumed.error);assert.equal(inputs,0);assert.equal(generated,0);
}));


test('saved flow clicks use the shared localizer instead of old guessed coordinates',async()=>fixture(async(screens)=>{
  const anchor={x:0,y:0,width:.4,height:.25};let clicked=false;
  const flow:Flow={name:'open',version:1,createdAt:0,purpose:'Open button',entry:'page',states:[{id:'page',snapshotId:'0',description:'Page',visualAnchors:[anchor],anchors:[{box:anchor,template:await fingerprint(screens[0].path,anchor)}],progressRegion:{x:0,y:0,width:1,height:1},doneWhen:'Button selected',settleMs:200,maxSettleMs:200,actions:[{id:'open',kind:'click',label:'blue button',when:'Not selected',box:{x:.05,y:.05,width:.05,height:.05}}]}]};
  const result=await runFlow(flow,contract,{}, {capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},choose:async(_p,choices)=>yes(choices.some(c=>c.id==='open')?(clicked?'done':'open'):'yes'),execute:async action=>{assert.ok(Math.abs(action.box!.x+action.box!.width/2-.5)<.001);clicked=true;return {};}});
  assert.equal(result.reason,'local_goal_observed');assert.equal(result.actions,1);
}));


test('scene SELECT authorizes animated clicks and rejects a covered target without a pixel veto',async()=>fixture(async(screens)=>{
  const box={x:.46,y:.46,width:.08,height:.08},anchor={x:0,y:0,width:1,height:1};
  for(const covered of [false,true]){
    let captures=0,selections=0,inputs=0;
    const result=await performAction(screens[0],{action:{id:'press',kind:'click',label:'blue button',intent:'Open',box},target:'blue button',grounded:{target:'blue button',source:screens[0],box},regions:[anchor]},undefined,{
      trace:async()=>{},capture:async()=>{captures++;return screens[2];},
      choose:async()=>{selections++;return yes(covered?'no':'yes');},
      execute:async()=>{inputs++;return {};},
    });
    assert.equal(result.performed,!covered);assert.equal(inputs,covered?0:1);
    if(!covered){assert.equal(selections,1);assert.equal(captures,1);}
  }
}));

test('semantic drag grounds its start and full route, then rechecks cached geometry on moving content',async()=>fixture(async screens=>{
  const drag={surface:'scrollable list',direction:'up' as const,view:{x:.4,y:.5,width:.05,height:.05}};
  const action={id:'scroll',kind:'drag' as const,label:'Move list',intent:'Find another item'};
  let index=0,locates=0,routes=0,inputs=0;
  const deps:Partial<ActionDeps>={capture:async()=>screens[index],trace:async()=>{},choose:async(state)=>{
    if(state.includes('pink crosshair'))locates++;
    if(state.includes('entire path'))routes++;
    return yes('yes');
  },execute:async()=>{inputs++;index=1;return {};}};
  const first=await performAction(screens[0],{action,drag},undefined,deps);
  assert.equal(first.performed,true);assert.equal(inputs,1);
  assert.ok(first.groundedDrag);assert.ok(first.action?.box&&first.action.to);
  assert.ok(first.action!.to!.y<first.action!.box!.y);
  assert.ok(first.action!.box!.y+first.action!.box!.height/2-first.action!.to!.y>drag.view.height,'Search hint must not bound gesture length');
  const afterFirst={locates,routes};
  const second=await performAction(screens[1],{action,drag,groundedDrag:first.groundedDrag},undefined,deps);
  assert.equal(second.performed,true);assert.equal(inputs,2);
  assert.equal(locates,afterFirst.locates);
  assert.ok(routes>afterFirst.routes);
}));

test('a rejected drag route never dispatches input',async()=>fixture(async screens=>{
  const action={id:'pan',kind:'drag' as const,label:'map surface',intent:'Inspect'};
  let inputs=0;
  const blocked=await performAction(screens[0],{action,drag:{surface:'map surface',direction:'left'}},undefined,{capture:async()=>screens[0],trace:async()=>{},choose:async(state)=>yes(state.includes('entire path')?'no':'yes'),execute:async()=>{inputs++;return {};}});
  assert.equal(blocked.performed,false);assert.equal(blocked.reason,'drag_route_unverified');assert.equal(inputs,0);
}));


test('기본 ACT는 미등록 클릭을 생성하거나 전송하지 않는다',async()=>fixture(async screens=>{
  let generations=0,inputs=0;
  const invalid=await runAct({goal:'버튼 열기'},contract,{},{
    capture:async()=>screens[0],trace:async()=>{},
    generate:async()=>{generations++;return '{}';},
    execute:async()=>{inputs++;return {};},
  });
  assert.equal(invalid.reason,'candidates_needed');assert.equal(generations,0);assert.equal(inputs,0);
}));

test('등록점은 공급 후 크기가 달라진 SELECT 화면에 재투영되고 추가 위치 추론 없이 정확히 입력된다',async()=>fixture(async screens=>{
  const entry=await addActPoint({snapshotId:'0',id:'registered',label:'파란 버튼',screen:'버튼 목록 화면',description:'목록 오른쪽의 파란 상세 열기 버튼',point:{x:.75,y:.5}});
  const path=join(screens[0].path,'..','wide.png');
  await sharp(screens[0].path).extend({left:120,right:120,top:0,bottom:0,background:'black'}).png().toFile(path);
  const wide:Snapshot={...screens[0],id:'wide',path,width:480,window:{...screens[0].window,frame:{x:0,y:0,width:480,height:180}}};
  screens.push(wide);
  let captures=0,inputs=0,selections=0,selectedImage:string|undefined;
  const projected=projectActPoint(entry,wide)!;
  const result=await runAct({goal:'파란 버튼 열기'},contract,{},{
    capture:async()=>++captures===1?screens[0]:wide,sleep:async()=>{},trace:async()=>{},
    generate:async()=>JSON.stringify({description:'버튼 화면',actions:[{id:'registered',kind:'click'}]}),
    choose:async(_prompt,choices,_signal,image)=>{
      if(choices.some(choice=>choice.id==='registered')){
        selections++;assert.equal(captures,2);
        selectedImage=image;return yes('registered');
      }
      return yes('yes');
    },
    execute:async(action,snapshot)=>{
      inputs++;assert.equal(snapshot.id,'wide');assert.equal(captures,2);
      const args=actionArgs(action,snapshot,300);assert.ok('x' in args&&'y' in args);assert.equal(args.x,projected.point.x*snapshot.width);assert.equal(args.y,projected.point.y*snapshot.height);return {};
    },
  });
  assert.equal(result.reason,'local_goal_observed',result.error);assert.equal(inputs,1);assert.equal(selections,1);
  assert.deepEqual(result.lastInput.point,projected.point);
  assert.equal(selectedImage,await renderActPointOverlay(wide,[projected]));
}));

test('기본 ACT 완료 확인은 격자 없이 원본 화면을 유지한다',async()=>fixture(async screens=>{
    await addActPoint({snapshotId:'0',id:'registered',label:'버튼',screen:'버튼 화면',description:'화면 오른쪽의 열기 버튼',point:{x:.75,y:.5}});
    let completionImage:string|undefined;
    const result=await runAct({goal:'완료 상태 확인'},contract,{},{
      capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},
      generate:async()=>JSON.stringify({description:'완료 화면',actions:[]}),
      choose:async(_prompt,choices,_signal,image)=>{
        if(choices.some(choice=>choice.id==='done'))return yes('done');
        completionImage=image;return yes('yes');
      },
      execute:async()=>{throw new Error('완료 확인은 입력을 보내면 안 된다');},
    });
    assert.equal(result.reason,'local_goal_observed',result.error);
    assert.ok(completionImage);
    const actual=await sharp(Buffer.from(completionImage,'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});
    const original=await sharp(screens[0].path).removeAlpha().raw().toBuffer();
    assert.deepEqual(actual.data,original);
}));

