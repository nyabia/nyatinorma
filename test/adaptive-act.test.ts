// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {dataDir} from '../src/config.js';
import {runAct,parseActState} from '../src/adaptive-act.js';
import {runExecution} from '../src/execution-controller.js';
import {revalidateObservation,performAction,type ActionDeps} from '../src/action-runtime.js';
import {InputNotSentError} from '../src/input-error.js';
import {CuaSessionRestoredError,CuaTimeoutError} from '../src/cua-transport.js';
import {runFlow,type Flow} from '../src/flow.js';
import {fingerprint} from '../src/vision.js';
import type {Snapshot,Decision} from '../src/types.js';

const yes=(choice:string):Decision=>({choice,legalMass:1,margin:.9,truncated:false,probabilities:{[choice]:1},reason:'test',elapsedMs:1});
const contract={revision:'test',requests:['Find the requested item, open it, then stop.']};
async function fixture(body:(screens:Snapshot[])=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'ny-act-'));
  try{
    const screens:Snapshot[]=[];
    for(let i=0;i<4;i++){
      const path=join(dir,`${i}.png`);
      await sharp(Buffer.from(`<svg width="240" height="180"><rect width="240" height="180" fill="rgb(${40+i*40},${40+i*40},${40+i*40})"/><rect width="50" height="30" fill="white"/><rect x="90" y="65" width="60" height="50" fill="blue"/></svg>`)).png().toFile(path);
      screens.push({id:String(i),path,width:240,height:180,at:Date.now(),ocr:[],window:{pid:1,windowId:2,title:'Test',frame:{x:0,y:0,width:240,height:180}}});
    }
    await body(screens);
  }finally{await rm(dir,{recursive:true,force:true});}
}

test('ACT reuses generated drag candidates, adapts to a new screen and locates a click without parent turns',async()=>fixture(async(screens)=>{
  let index=0,generated=0,inputs=0,locates=0;
  const result=await runAct({goal:'Find and open item',doneWhen:'Details visible'},contract,{}, {
    capture:async()=>screens[index],sleep:async()=>{},trace:async()=>{},
    generate:async prompt=>{assert.match(prompt,/then stop/);generated++;return JSON.stringify(generated===1?{description:'List',actions:[{id:'scroll',kind:'drag',surface:'list',regionPath:['C3'],direction:'up',when:'Item absent',expectation:'More items visible'}]}:{description:'Item visible',actions:[{id:'open',kind:'click',target:'blue item button',when:'Item visible',expectation:'Details visible'}]});},
    choose:async(prompt,choices)=>{
      if(choices.some(c=>c.id==='confirm'))throw new Error('Unexpected choices');
      if(choices[0].id==='yes'){
        if(prompt.includes('pink')||prompt.includes('crosshair'))locates++;
        if(prompt.includes('Completion check')&&index<3)return yes('no');
        return yes('yes');
      }
      if(choices.some(c=>c.id==='moved'))return yes(index>=2?'found':'moved');
      if(choices.some(c=>c.id==='scroll'))return yes(index<2?'scroll':'rebuild');
      return yes(index===3?'done':'open');
    },
    execute:async action=>{inputs++;if(action.kind==='click'){assert.equal(index,2);assert.ok(Math.abs(action.box!.x+action.box!.width/2-.5)<.001);}index++;return {focusPreserved:true};},
  });
  assert.equal(result.reason,'local_goal_observed',result.error);assert.equal(result.actions,3);assert.equal(inputs,3);assert.equal(generated,2);assert.ok(result.selectCalls>=7);
}));

test('ACT never repeats a click whose expected result is unconfirmed; cancellation before dispatch also stops input',async()=>fixture(async(screens)=>{
  for(const cancel of [false,true]){
    const controller=new AbortController();let inputs=0;
    const result=await runAct({goal:'Open button',doneWhen:'Details visible'},contract,{signal:controller.signal},{capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},generate:async()=>JSON.stringify({description:'Button',actions:[{id:'open',kind:'click',target:'blue button',when:'Visible',expectation:'Details visible'}]}),choose:async(prompt,choices)=>{
      if(choices.some(c=>c.id==='open')){if(cancel)controller.abort();return yes('open');}
      if(prompt.includes('A click on'))return yes('no');
      return yes('yes');
    },execute:async()=>{inputs++;return {};}});
    assert.equal(inputs,cancel?0:1);assert.equal(result.reason,cancel?'cancelled':'outcome_unconfirmed');
  }
}));

test('pending user instruction yields a resumable goal without sending input',async()=>fixture(async(screens)=>{
 const result=await runAct({goal:'Open button'},contract,{interrupted:()=>true},{capture:async()=>screens[0],trace:async()=>{},generate:async()=>{throw new Error('Must not generate before reviewing pending user input');},execute:async()=>{throw new Error('Must not dispatch');}});
 assert.equal(result.status,'yielded');assert.equal(result.reason,'user_instruction_pending');assert.ok(result.nextCall?.resume);assert.equal(result.lastInput.delivery,'not_sent');
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
  const first=await runAct({goal:'Open button',until:'Details visible'},contract,{},deps);
  assert.equal(first.reason,'input_outcome_unknown');assert.equal(first.lastInput.delivery,'unknown');assert.equal(first.lastInput.outcome,'unresolved');assert.ok(first.continuationId);
  const resumed=await runAct({resume:first.continuationId},contract,{},deps);
  assert.equal(resumed.reason,'local_goal_observed',resumed.error);assert.equal(resumed.lastInput.outcome,'observed');assert.equal(inputs,1);
}));

test('a sent click with two fresh no-effect observations yields for a new decision without replay',async()=>fixture(async(screens)=>{
  const id=`${Date.now()}-${randomUUID().slice(0,8)}`;
  const before={...screens[0],id};
  const capturePath=join(dataDir,'captures',`${id}.json`);
  await mkdir(join(dataDir,'captures'),{recursive:true});
  await writeFile(capturePath,JSON.stringify(before));
  try{
    let inputs=0,captures=0,noEffectChecks=0;
    const deps={capture:async()=>{captures++;return before;},sleep:async()=>{},trace:async()=>{},
      generate:async()=>JSON.stringify({description:'Button',actions:[{id:'open',kind:'click',target:'blue button',when:'Visible',expectation:'Details visible'}]}),
      choose:async(_prompt:string,choices:{id:string}[])=>{
        if(choices.some(c=>c.id==='no_effect')){noEffectChecks++;return yes('no_effect');}
        if(choices.some(c=>c.id==='open'))return yes('open');
        if(_prompt.includes('A click on'))return yes('no');
        if(choices.some(c=>c.id==='yes'))return yes('yes');
        return yes('no');
      },execute:async()=>{inputs++;return {focusPreserved:true};}};
    const first=await runAct({goal:'Open button',until:'Details visible'},contract,{},deps);
    assert.equal(first.reason,'outcome_unconfirmed');assert.equal(first.lastInput.delivery,'sent');assert.equal(inputs,1);
    const capturesBeforeResume=captures;
    const resumed=await runAct({resume:first.continuationId},contract,{},deps);
    assert.equal(resumed.reason,'input_no_effect_observed',resumed.error);assert.equal(resumed.status,'needs_decision');
    assert.equal(resumed.lastInput.delivery,'sent');assert.equal(resumed.lastInput.outcome,'observed');
    assert.equal(resumed.lastInput.beforeSnapshotId,id);assert.equal(resumed.lastInput.afterSnapshotId,id);
    assert.equal(noEffectChecks,2);assert.ok(captures-capturesBeforeResume>=2);assert.equal(inputs,1);
    assert.match(resumed.summary,/no visible expected effect/);
    const unknownDeps={...deps,execute:async()=>{throw new CuaTimeoutError('click');},choose:async(prompt:string,choices:{id:string}[])=>{
      if(choices.some(c=>c.id==='observed')){assert.ok(!choices.some(c=>c.id==='no_effect'),'unknown delivery must not expose no-effect reconciliation');return yes('decision');}
      if(choices.some(c=>c.id==='open'))return yes('open');
      if(prompt.includes('A click on'))return yes('no');
      return yes('yes');
    }};
    const unknown=await runAct({goal:'Open button',until:'Details visible'},contract,{},unknownDeps);
    assert.equal(unknown.reason,'input_outcome_unknown');assert.equal(unknown.lastInput.delivery,'unknown');
    const unknownResume=await runAct({resume:unknown.continuationId},contract,{},unknownDeps);
    assert.equal(unknownResume.reason,'input_outcome_unknown');assert.equal(unknownResume.lastInput.outcome,'unresolved');
  }finally{await rm(capturePath,{force:true});}
}));

test('uncertain click candidates inspect detail and can refine competing choices before input',async()=>fixture(async(screens)=>{
 for(const refine of [false,true]){
  let attempts=0,inspections=0,inputs=0;
  const result=await runAct({goal:'Open button',until:'Details visible'},contract,{}, {
    capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},
    generate:async()=>JSON.stringify({description:'Button',actions:[{id:'open',kind:'click',target:'blue button',when:'Visible',expectation:'Details visible'}]}),
    choose:async(prompt,choices)=>{
      if(choices.some(c=>c.id==='inspect_4')){inspections++;return yes('inspect_4');}
      if(choices.some(c=>c.id==='open')){
        attempts++;assert.equal(inputs,0);
        if(attempts===1)return {...yes('open'),legalMass:0,margin:0};
        if(attempts===2){assert.match(prompt,/enlarged detail/);if(refine)return {...yes('open'),probabilities:{open:.4,stop:.35,wait:.25},margin:.05};}
        if(attempts===3){assert.match(prompt,/Resolve these two competing/);assert.deepEqual(choices.map(c=>c.id),['open','stop','unclear']);}
        return yes('open');
      }
      return yes('yes');
    },execute:async()=>{inputs++;return {};},
  });
  assert.equal(result.reason,'local_goal_observed',result.error);assert.equal(attempts,refine?3:2);assert.equal(inspections,1);assert.equal(inputs,1);
 }
}));

test('a passive wait remains input-free when resumed through ACT',async()=>fixture(async(screens)=>{
  let phase=0,generated=0,inputs=0;
  const choose=async(_prompt:string,choices:{id:string}[])=>yes(choices.some(c=>c.id==='done')?(phase++===0?'wait':'done'):'yes');
  const first=await runExecution({goal:'Wait for ready',until:'Ready',mode:'wait'},async()=>({description:'Waiting',actions:[{id:'click',kind:'click',label:'button',target:'button',when:'Visible',expectation:'Clicked'}]}),contract,{maxWaits:0},{capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},choose,execute:async()=>{inputs++;return {};}});
  assert.equal(first.reason,'wait_budget');assert.ok(first.continuationId);
  const resumed=await runAct({resume:first.continuationId},contract,{}, {capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},choose,execute:async()=>{inputs++;return {};},generate:async()=>{generated++;return '{}';}});
  assert.equal(resumed.reason,'local_goal_observed',resumed.error);assert.equal(inputs,0);assert.equal(generated,0);
}));

test('old observations renew through scene SELECT; NO, uncertainty and window changes reject',async()=>fixture(async(screens)=>{
  const old={...screens[0],at:0};let calls=0;
  const deps:Partial<ActionDeps>={capture:async()=>screens[0],choose:async()=>{calls++;return yes('yes');}};
  assert.equal((await revalidateObservation(old,{},deps)).same,true);assert.equal(calls,0);
  deps.capture=async()=>screens[1];assert.equal((await revalidateObservation(old,{},deps)).same,true);assert.equal(calls,1);
  deps.choose=async()=>yes('no');assert.equal((await revalidateObservation(old,{},deps)).same,false);
  deps.choose=async()=>({...yes('yes'),truncated:true});assert.equal((await revalidateObservation(old,{},deps)).same,false);
  deps.capture=async()=>({...screens[0],window:{...screens[0].window,pid:99}});assert.equal((await revalidateObservation(old,{},deps)).reason,'window_changed');
  for(const kind of ['click','drag'] as const){
    let captures=0;deps.capture=async()=>{captures++;return screens[1];};deps.choose=async()=>yes('yes');
    const accepted=await revalidateObservation(old,{kind,targets:[{x:.8,y:.8,width:.05,height:.05}]},deps);
    assert.equal(accepted.same,true);assert.equal(accepted.reason,'select_confirmed');assert.equal(captures,1,'No post-SELECT pixel veto or recapture loop');
  }
}));

test('only a proven rejected input can retry after session recovery; timeouts and changed screens never replay',async()=>fixture(async(screens)=>{
  const action={id:'move',kind:'drag' as const,label:'Move',intent:'Inspect',box:{x:.6,y:.6,width:.1,height:.1},to:{x:.2,y:.6}};
  for(const mode of ['restored','changed','timeout']){
    let inputs=0,checks=0,cleared=0;
    const pending=performAction(screens[0],{action,onNotDispatched:async()=>{cleared++;}},undefined,{capture:async()=>screens[0],choose:async()=>{checks++;return yes(mode==='changed'&&checks>1?'no':'yes');},execute:async()=>{if(++inputs===1)throw mode==='timeout'?new CuaTimeoutError('drag'):new CuaSessionRestoredError();return {};}});
    if(mode==='timeout')await assert.rejects(pending,/unknown/);
    else assert.equal((await pending).performed,mode==='restored');
    assert.equal(inputs,mode==='restored'?2:1);assert.equal(checks,mode==='timeout'?1:2);
    assert.equal(cleared,mode==='timeout'?0:1);
  }
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
  const third=await performAction(screens[1],{action,drag:{...drag,amount:'small'},groundedDrag:second.groundedDrag},undefined,deps);
  assert.equal(third.performed,true);assert.ok(locates>afterFirst.locates,'Changed amount must not reuse the previous route');
  const distance=(a:any)=>Math.abs(a.box.y+a.box.height/2-a.to.y);
  assert.ok(distance(third.action)<distance(first.action));
}));

test('a rejected arrow never dispatches and hooks receive the exact prepared drag',async()=>fixture(async screens=>{
  const action={id:'pan',kind:'drag' as const,label:'map surface',intent:'Inspect'};
  let inputs=0;
  const blocked=await performAction(screens[0],{action,drag:{surface:'map surface',direction:'left'}},undefined,{capture:async()=>screens[0],trace:async()=>{},choose:async(state)=>yes(state.includes('entire path')?'no':'yes'),execute:async()=>{inputs++;return {};}});
  assert.equal(blocked.performed,false);assert.equal(blocked.reason,'drag_route_unverified');assert.equal(inputs,0);
  const events:string[]=[];
  const sent=await performAction(screens[0],{action,drag:{surface:'map surface',direction:'left'},beforeDispatch:async(prepared,snapshot)=>{
    assert.equal(snapshot.id,'0');assert.ok(prepared.box&&prepared.to);assert.ok(prepared.to.x<prepared.box.x);events.push('before');
  },afterDispatch:async()=>{events.push('after');}},undefined,{capture:async()=>screens[0],trace:async()=>{},choose:async()=>yes('yes'),execute:async()=>{events.push('execute');inputs++;return {};}});
  assert.equal(sent.performed,true);assert.deepEqual(events,['before','execute','after']);assert.equal(inputs,1);
}));

test('a cancellation after preparing input clears only that unsent attempt',async()=>fixture(async screens=>{
  let prepared=false,cleared=0,inputs=0;
  const pending=performAction(screens[0],{action:{id:'pan',kind:'drag',label:'map',intent:'Inspect',box:{x:.6,y:.6,width:.1,height:.1},to:{x:.2,y:.6}},beforeDispatch:async()=>{prepared=true;},onNotDispatched:async reason=>{assert.equal(reason,'before_execute');cleared++;}},undefined,{
    capture:async()=>screens[0],choose:async()=>yes('yes'),check:()=>{if(prepared)throw new Error('interrupted');},execute:async()=>{inputs++;return {};},
  });
  await assert.rejects(pending,/interrupted/);assert.equal(cleared,1);assert.equal(inputs,0);
}));

test('ACT reports provider failure without retrying it as a JSON repair',async()=>fixture(async(screens)=>{
  let generations=0;
  const result=await runAct({goal:'Find item'},contract,{}, {
    capture:async()=>screens[0],trace:async()=>{},
    generate:async()=>{generations++;throw new Error('Provider unavailable');},
    execute:async()=>{throw new Error('No input expected');},
  });
  assert.equal(result.status,'error');assert.equal(result.error,'Provider unavailable');assert.equal(generations,1);assert.equal(result.actions,0);
}));

test('ACT carries a broad input surface intent into location confirmation',async()=>fixture(async(screens)=>{
  let locationChecks=0,inputs=0;
  const goal='Dismiss the overlay by tapping anywhere on its empty surface';
  const result=await runAct({goal,until:'Overlay gone'}, {revision:'surface',requests:[goal]}, {}, {
    capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},
    generate:async()=>JSON.stringify({description:'Dismissible overlay',actions:[{id:'dismiss',kind:'click',target:'tap-anywhere overlay surface',when:'Overlay visible',expectation:'Overlay gone'}]}),
    choose:async(prompt,choices)=>{
      if(prompt.includes('Completion check')){assert.match(prompt,/requires its ABSENCE/);assert.match(choices[0].label,/required absence/);}
      if(prompt.includes('Judge ONLY the existing pink crosshair')){
        locationChecks++;assert.match(prompt,/Local goal: Dismiss the overlay/);assert.match(prompt,/Expected effect: Overlay gone/);assert.match(prompt,/do not require a rendered button/);
      }
      return yes(choices.some(c=>c.id==='dismiss')?'dismiss':'yes');
    },execute:async()=>{inputs++;return {};},
  });
  assert.equal(result.status,'done');assert.equal(locationChecks,1);assert.equal(inputs,1);
}));

test('scroll SELECT adjusts distance and direction across a yield without THINK or pixel veto, and reports a boundary',async()=>fixture(async screens=>{
  let inputs=0,generations=0,refinements=0;const routes:{direction:string;distance:number}[]=[];
  const deps={capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},
    generate:async()=>{generations++;return JSON.stringify({description:'Scrolling list',actions:[{id:'search',kind:'drag',surface:'list',surfaceRegion:'C1:D4',direction:'up',amount:'large',when:'Target absent',expectation:'Find target'}]});},
    choose:async(prompt:string,choices:{id:string}[])=>{
      if(choices.some(c=>c.id==='boundary')){
        assert.match(prompt,/enlarged BEFORE\/CURRENT/);
        if(inputs===1)return {...yes('smaller'),probabilities:{smaller:.4,reverse:.3,moved:.2,unclear:.1},margin:.1};
        return yes(inputs===2?'reverse':inputs===3?'retry':'boundary');
      }
      if(prompt.includes('Resolve these two competing')){refinements++;assert.deepEqual(choices.map(c=>c.id),['smaller','reverse','unclear']);return yes('smaller');}
      return yes(choices.some(c=>c.id==='search')?'search':'yes');
    },execute:async(action:any)=>{inputs++;const distance=action.to.y-(action.box.y+action.box.height/2);routes.push({direction:distance>0?'down':'up',distance:Math.abs(distance)});return {};},
  };
  const first=await runAct({goal:'Find item in list',maxActions:1},contract,{},deps);
  assert.equal(first.reason,'action_budget');assert.equal(inputs,1);assert.ok(first.continuationId);
  const result=await runAct({resume:first.continuationId},contract,{},deps);
  assert.equal(result.reason,'search_boundary_observed',result.error);assert.equal(result.status,'needs_decision');
  assert.equal(inputs,4);assert.equal(refinements,1);assert.equal(generations,1,'SELECT adjustments reuse candidates, including after resume');
  assert.deepEqual(routes.map(r=>r.direction),['up','up','down','down']);assert.ok(routes[1].distance<routes[0].distance);assert.ok(routes[2].distance<routes[1].distance);
  assert.equal(result.lastInput.outcome,'observed');assert.equal(result.evidence.length,1);
  assert.throws(()=>parseActState(JSON.stringify({description:'List',actions:[{id:'scroll',kind:'drag',surface:'list',surfaceRegion:'D4:C1',direction:'up',when:'Missing',expectation:'Moved'}]})),/surfaceRegion/);
}));

test('a driver preflight rejection clears prepared input without claiming an effect or replaying',async()=>fixture(async screens=>{
  let calls=0;
  const result=await runAct({goal:'Scroll list'},contract,{}, {
    capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},
    generate:async()=>JSON.stringify({description:'List',actions:[{id:'scroll',kind:'drag',surface:'list',direction:'up',when:'Target absent',expectation:'Moved'}]}),
    choose:async(_prompt,choices)=>yes(choices.some(c=>c.id==='scroll')?'scroll':'yes'),
    execute:async()=>{calls++;throw new InputNotSentError(new Error('preflight'));},
  });
  assert.equal(calls,1);assert.equal(result.lastInput.delivery,'not_sent');assert.equal(result.lastInput.outcome,'not_applicable');assert.equal(result.actions,0);
}));
