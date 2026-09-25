// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {runFlow,workContract,type Flow,type FlowDeps} from '../src/flow.js';
import {fingerprint} from '../src/vision.js';
import type {Snapshot,Decision} from '../src/types.js';

const roi={x:0,y:.4,width:1,height:.6},anchor={x:0,y:0,width:.5,height:.2};
const contract={revision:'u1',requests:['Find the requested item.','Stop after one.']};
const decision=(choice:string):Decision=>({choice,legalMass:.99,margin:.8,probabilities:{[choice]:.95},truncated:false,reason:'test',elapsedMs:1});
async function fixture(body:(flow:Flow,screens:Snapshot[])=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'ny-flow-'));
 try{
  const screens:Snapshot[]=[];
  for(let i=0;i<12;i++){
   const path=join(dir,`${i}.png`);const color=i===11?'black':'white',background=i===11?'white':'black';
   await sharp(Buffer.from(`<svg width="200" height="200"><rect width="200" height="200" fill="${background}"/><rect width="50" height="40" fill="${color}"/><rect y="80" width="200" height="120" fill="rgb(${i*20},${i*20},${i*20})"/></svg>`)).png().toFile(path);
   screens.push({id:String(i),path,at:Date.now(),width:200,height:200,ocr:[],window:{pid:1,windowId:2,title:'Example',frame:{x:0,y:0,width:200,height:200}}});
  }
  const flow:Flow={name:'scroll',version:1,purpose:'Find an item',entry:'list',createdAt:0,states:[{id:'list',description:'List',snapshotId:'0',visualAnchors:[anchor],anchors:[{box:anchor,template:await fingerprint(screens[0].path,anchor)}],progressRegion:roi,doneWhen:'The requested item is visible',settleMs:200,maxSettleMs:200,maxNoProgress:2,actions:[{id:'move',kind:'drag',label:'Move',when:'No requested item visible and list can move',box:{x:.6,y:.6,width:.1,height:.1},to:{x:.1,y:.6},targetGuard:'region'}]}]};
  await body(flow,screens);
 }finally{await rm(dir,{recursive:true,force:true});}
}

test('ten changing-region drags and completion stay in one executor with original goal',async()=>fixture(async(flow,screens)=>{
 let index=0,calls=0;const trace:any[]=[];
 const r=await runFlow(flow,contract,{maxActions:20},{capture:async()=>screens[index],sleep:async()=>{},execute:async()=>{index++;return {};},choose:async(prompt,choices)=>{calls++;assert.match(prompt,/Find the requested item/);assert.match(prompt,/Stop after one/);assert.ok(choices.some(c=>c.id==='move'));return decision(index===10?'done':'move');},trace:async e=>{trace.push(e);}});
 assert.equal(r.reason,'local_goal_observed');assert.equal(r.actions,10);assert.equal(calls,11);assert.equal(trace.filter(e=>e.event==='dispatch').length,10);
}));

test('unchanged list blocks more drags and never declares completion automatically',async()=>fixture(async(flow,screens)=>{
 let inputs=0;
 const r=await runFlow(flow,contract,{}, {capture:async()=>screens[0],sleep:async()=>{},execute:async()=>{inputs++;},choose:async(_p,choices)=>decision(choices.some(c=>c.id==='move')?'move':'replan'),trace:async()=>{}});
 assert.equal(inputs,2);assert.equal(r.reason,'stalled');
}));

test('a found item stops before any next drag',async()=>fixture(async(flow,screens)=>{
 const r=await runFlow(flow,contract,{}, {capture:async()=>screens[0],choose:async()=>decision('done'),execute:async()=>{throw new Error('must not input');},trace:async()=>{}});
 assert.equal(r.actions,0);assert.equal(r.reason,'local_goal_observed');
}));

test('observation-only flows wait without input or planner turns and respect their wait budget',async()=>fixture(async(flow,screens)=>{
 flow.states[0].actions=[];
 for(const maxWaits of [2,12]){
  flow.states[0].maxWaits=maxWaits;let calls=0;
  const r=await runFlow(flow,contract,{}, {capture:async()=>screens[0],sleep:async()=>{},execute:async()=>{throw new Error('must not input');},choose:async()=>decision(++calls===11?'done':'wait'),trace:async()=>{}});
  assert.equal(r.reason,maxWaits===2?'wait_budget':'local_goal_observed');
  assert.equal(r.actions,0);assert.equal(r.selectCalls,maxWaits===2?3:11);
 }
}));

test('a single observation-only wait spans screens without anchors; input still requires anchors',async()=>fixture(async(flow,screens)=>{
 flow.states[0].anchors=[];let selected=false;
 const deps:Partial<FlowDeps>={capture:async()=>screens[11],execute:async()=>{throw new Error('must not input');},choose:async()=>{selected=true;return decision('done');},trace:async()=>{}};
 assert.equal((await runFlow(flow,contract,{},deps)).reason,'unknown_screen');assert.equal(selected,false);
 flow.states[0].actions=[];
 assert.equal((await runFlow(flow,contract,{},deps)).reason,'local_goal_observed');assert.equal(selected,true);
}));

test('passive wait confirms completion across fresh frames and tolerates only bounded transient uncertainty',async()=>fixture(async(flow,screens)=>{
 flow.states[0].actions=[];flow.states[0].anchors=[];
 for(const sequence of [['done','wait','replan','done','done'],['replan','replan','replan']]){
  let captures=0,calls=0;
  const r=await runFlow(flow,contract,{confirmDone:2,transientRetries:2},{capture:async()=>screens[captures++],sleep:async()=>{},execute:async()=>{throw new Error('must not input');},choose:async()=>decision(sequence[calls++]),trace:async()=>{}});
  assert.equal(r.reason,sequence.length===5?'local_goal_observed':'replan');assert.equal(calls,sequence.length);assert.equal(captures,sequence.length);assert.equal(r.actions,0);
 }
}));

test('transient uncertainty tolerance cannot be used in a flow that dispatches input',async()=>fixture(async(flow)=>{
 await assert.rejects(runFlow(flow,contract,{transientRetries:1}),/observation-only/);
}));

test('unknown screens and pending user instructions do not dispatch input',async()=>fixture(async(flow,screens)=>{
 for(const pending of [false,true]){
  const r=await runFlow(flow,contract,{interrupted:()=>pending},{capture:async()=>screens[11],choose:async()=>{throw new Error('must not choose');},execute:async()=>{throw new Error('must not input');},trace:async()=>{}});
  assert.equal(r.reason,pending?'error':'unknown_screen');assert.equal(r.actions,0);
 }
}));

test('cancellation during selection prevents any delayed input',async()=>fixture(async(flow,screens)=>{
 const controller=new AbortController();let calls=0;
 const r=await runFlow(flow,contract,{signal:controller.signal},{capture:async()=>screens[0],choose:async()=>{controller.abort();return decision('move');},execute:async()=>{calls++;},trace:async()=>{}});
 assert.equal(r.reason,'cancelled');assert.equal(calls,0);
}));

test('a registered next screen continues without a planner return',async()=>fixture(async(flow,screens)=>{
 flow.states[0].actions[0].next=['second'];
 flow.states.push({...flow.states[0],id:'second',snapshotId:'11',description:'Second screen',anchors:[{box:anchor,template:await fingerprint(screens[11].path,anchor)}],actions:[]});
 let index=0;
 const r=await runFlow(flow,contract,{}, {capture:async()=>screens[index],sleep:async()=>{},execute:async()=>{index=11;},choose:async prompt=>decision(prompt.includes('State: Second screen')?'done':'move'),trace:async()=>{}});
 assert.equal(r.state,'second');assert.equal(r.reason,'local_goal_observed');assert.equal(r.actions,1);
}));

test('changed target window between choice and input prevents dispatch',async()=>fixture(async(flow,screens)=>{
 let captures=0;
 const r=await runFlow(flow,contract,{}, {capture:async()=>++captures===1?screens[0]:{...screens[0],window:{...screens[0].window,pid:10}},choose:async()=>decision('move'),execute:async()=>{throw new Error('must not input');},trace:async()=>{}});
 assert.equal(r.reason,'window_changed');assert.equal(r.actions,0);
}));

test('working contract preserves the first request and later corrections across other entries',()=>{
 assert.deepEqual(workContract([{type:'message',id:'first',message:{role:'user',content:[{type:'text',text:'Original goal'}]}},{type:'compaction',summary:'summary'},{type:'message',message:{role:'assistant',content:[]}},{type:'message',id:'last',message:{role:'user',content:'Only one'}}]),{revision:'last',requests:['Original goal','Only one']});
});
