// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {runAct} from '../src/adaptive-act.js';
import {revalidateObservation,performAction,type ActionDeps} from '../src/action-runtime.js';
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
        return yes('yes');
      }
      if(choices.some(c=>c.id==='scroll'))return yes(index<2?'scroll':'rebuild');
      return yes(index===3?'done':'open');
    },
    execute:async action=>{inputs++;if(action.kind==='click'){assert.equal(index,2);assert.ok(Math.abs(action.box!.x+action.box!.width/2-.5)<.001);}index++;return {focusPreserved:true};},
  });
  assert.equal(result.reason,'local_goal_observed');assert.equal(result.actions,3);assert.equal(inputs,3);assert.equal(generated,2);assert.ok(result.selectCalls>=7);
}));

test('ACT never repeats a click whose expected result is unconfirmed; cancellation before dispatch also stops input',async()=>fixture(async(screens)=>{
  for(const cancel of [false,true]){
    const controller=new AbortController();let inputs=0;
    const result=await runAct({goal:'Open button',doneWhen:'Details visible'},contract,{signal:controller.signal},{capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},generate:async()=>JSON.stringify({description:'Button',actions:[{id:'open',kind:'click',target:'blue button',when:'Visible',expectation:'Details visible'}]}),choose:async(prompt,choices)=>{
      if(choices.some(c=>c.id==='open')){if(cancel)controller.abort();return yes('open');}
      if(prompt.includes('An input was just dispatched'))return yes('no');
      return yes('yes');
    },execute:async()=>{inputs++;return {};}});
    assert.equal(inputs,cancel?0:1);assert.equal(result.reason,cancel?'cancelled':'outcome_unconfirmed');
  }
}));

test('old observation renewal uses exact pixels or a conservative SELECT, and rejects window/late changes',async()=>fixture(async(screens)=>{
  const old={...screens[0],at:0};let calls=0;
  const deps:Partial<ActionDeps>={capture:async()=>screens[0],choose:async()=>{calls++;return yes('yes');}};
  assert.equal((await revalidateObservation(old,{},deps)).same,true);assert.equal(calls,0);
  deps.capture=async()=>screens[1];assert.equal((await revalidateObservation(old,{},deps)).same,true);assert.equal(calls,1);
  deps.choose=async()=>yes('no');assert.equal((await revalidateObservation(old,{},deps)).same,false);
  deps.choose=async()=>({...yes('yes'),truncated:true});assert.equal((await revalidateObservation(old,{},deps)).same,false);
  deps.capture=async()=>({...screens[0],window:{...screens[0].window,pid:99}});assert.equal((await revalidateObservation(old,{},deps)).reason,'window_changed');
  let n=0;deps.capture=async()=>screens[++n%4];deps.choose=async()=>yes('yes');assert.equal((await revalidateObservation(old,{},deps)).same,false);
}));

test('only a proven rejected input can retry after session recovery; timeouts and changed screens never replay',async()=>fixture(async(screens)=>{
  const action={id:'move',kind:'drag' as const,label:'Move',intent:'Inspect',box:{x:.6,y:.6,width:.1,height:.1},to:{x:.2,y:.6}};
  for(const mode of ['restored','changed','timeout']){
    let inputs=0,checks=0;
    const pending=performAction(screens[0],{action},undefined,{capture:async()=>screens[0],choose:async()=>{checks++;return yes(mode==='changed'?'no':'yes');},execute:async()=>{if(++inputs===1)throw mode==='timeout'?new CuaTimeoutError('drag'):new CuaSessionRestoredError();return {};}});
    if(mode==='timeout')await assert.rejects(pending,/unknown/);
    else assert.equal((await pending).performed,mode==='restored');
    assert.equal(inputs,mode==='restored'?2:1);assert.equal(checks,mode==='timeout'?0:1);
  }
}));

test('saved flow clicks use the shared localizer instead of old guessed coordinates',async()=>fixture(async(screens)=>{
  const anchor={x:0,y:0,width:.4,height:.25};let clicked=false;
  const flow:Flow={name:'open',version:1,createdAt:0,purpose:'Open button',entry:'page',states:[{id:'page',snapshotId:'0',description:'Page',visualAnchors:[anchor],anchors:[{box:anchor,template:await fingerprint(screens[0].path,anchor)}],progressRegion:{x:0,y:0,width:1,height:1},doneWhen:'Button selected',settleMs:200,maxSettleMs:200,actions:[{id:'open',kind:'click',label:'blue button',when:'Not selected',box:{x:.05,y:.05,width:.05,height:.05}}]}]};
  const result=await runFlow(flow,contract,{}, {capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},choose:async(_p,choices)=>yes(choices.some(c=>c.id==='open')?(clicked?'done':'open'):'yes'),execute:async action=>{assert.ok(Math.abs(action.box!.x+action.box!.width/2-.5)<.001);clicked=true;return {};}});
  assert.equal(result.reason,'local_goal_observed');assert.equal(result.actions,1);
}));
