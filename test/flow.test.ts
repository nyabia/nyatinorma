// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {runFlow,workContract,type Flow} from '../src/flow.js';
import {fingerprint} from '../src/vision.js';
import {dataDir,defaults} from '../src/config.js';
import {withExecutionHost,type ExecutionHost} from '../src/host-context.js';
import type {Continuation} from '../src/execution-contract.js';
import type {Snapshot,Decision} from '../src/types.js';

const roi={x:0,y:.4,width:1,height:.6},anchor={x:0,y:0,width:.5,height:.2};
const contract={revision:'u1',requests:['Find the requested item.','Stop after one.']};
const decision=(choice:string):Decision=>({choice,legalMass:.99,margin:.8,probabilities:{[choice]:.95},truncated:false,reason:'test',elapsedMs:1});
async function fixture(body:(flow:Flow,screens:Snapshot[])=>Promise<void>){
 await mkdir(join(dataDir,'test-tmp'),{recursive:true});
 const dir=await mkdtemp(join(dataDir,'test-tmp','ny-flow-'));
 try{
  const screens:Snapshot[]=[];
  for(let i=0;i<5;i++){
   const path=join(dir,`${i}.png`);const color=i===4?'black':'white',background=i===4?'white':'black';
   await sharp(Buffer.from(`<svg width="200" height="200"><rect width="200" height="200" fill="${background}"/><rect width="50" height="40" fill="${color}"/><rect y="80" width="200" height="120" fill="rgb(${i*20},${i*20},${i*20})"/></svg>`)).png().toFile(path);
   screens.push({id:String(i),path,at:Date.now(),width:200,height:200,ocr:[],window:{pid:1,windowId:2,title:'Example',frame:{x:0,y:0,width:200,height:200}}});
  }
  const flow:Flow={name:'scroll',version:1,purpose:'Find an item',entry:'list',createdAt:0,states:[{id:'list',description:'List',snapshotId:'0',visualAnchors:[anchor],anchors:[{box:anchor,template:await fingerprint(screens[0].path,anchor)}],progressRegion:roi,doneWhen:'The requested item is visible',settleMs:200,maxSettleMs:200,maxNoProgress:2,actions:[{id:'move',kind:'drag',label:'Move',when:'No requested item visible and list can move',box:{x:.6,y:.6,width:.1,height:.1},to:{x:.1,y:.6},targetGuard:'region'}]}]};
  const continuations=new Map<string,Continuation>();let active:string|undefined;
  const host:ExecutionHost={id:randomUUID(),inputScope:randomUUID(),config:async()=>({...defaults}),loadContinuation:async id=>structuredClone(continuations.get(id??active??'')),saveContinuation:async value=>{continuations.set(value.id,structuredClone(value));active=value.id;},snapshot:async id=>screens.find(s=>s.id===id)};
  await withExecutionHost(host,()=>body(flow,screens));
 }finally{await rm(dir,{recursive:true,force:true});}
}

test('saved procedure scrolls repeatedly and observes completion inside the common executor',async()=>fixture(async(flow,screens)=>{
 let index=0;flow.states[0].actions[0].amount='small';
 const r=await runFlow(flow,contract,{}, {capture:async()=>screens[index],sleep:async()=>{},execute:async(action)=>{
  assert.ok(action.box&&action.to);
  const start={x:action.box.x+action.box.width/2,y:action.box.y+action.box.height/2};
  assert.ok(action.to.x<start.x);assert.equal(action.to.y,start.y);
  index++;return {};
 },choose:async(_prompt,choices)=>{
  if(choices.some(c=>c.id==='moved'))return decision(index===3?'found':'moved');
  if(choices[0].id==='yes')return decision('yes');
  return decision(index===3?'done':'move');
 },trace:async()=>{}});
 assert.equal(r.reason,'local_goal_observed',r.error);assert.equal(r.actions,3);
}));

test('an unknown dispatch blocks its own session without poisoning another flow fixture',async()=>{
 await fixture(async(flow,screens)=>{
  const deps={capture:async()=>screens[0],sleep:async()=>{},trace:async()=>{},
   choose:async(_prompt:string,choices:{id:string}[])=>decision(choices[0].id==='yes'?'yes':'move'),
   execute:async()=>{throw new Error('driver disconnected after dispatch');}};
  const result=await runFlow(flow,contract,{},deps);
  assert.equal(result.reason,'input_outcome_unknown');assert.equal(result.lastInput.outcome,'unresolved');
  await assert.rejects(runFlow(flow,contract,{},deps),/unresolved/i);
 });
 await fixture(async(flow,screens)=>{
  let inputs=0;
  const result=await runFlow(flow,contract,{},{
   capture:async()=>screens[inputs],sleep:async()=>{},trace:async()=>{},
   choose:async(_prompt,choices)=>decision(choices.some(c=>c.id==='moved')?'found':choices[0].id==='yes'?'yes':'move'),
   execute:async()=>{inputs++;return {};},
  });
  assert.equal(result.reason,'local_goal_observed',result.error);assert.equal(inputs,1);
 });
});

test('no movement requires a decision, never automatic completion or a fixed replay count',async()=>fixture(async(flow,screens)=>{
 let inputs=0;
 const r=await runFlow(flow,contract,{}, {capture:async()=>screens[0],sleep:async()=>{},execute:async()=>{inputs++;},choose:async(_p,choices)=>{
  if(choices[0].id==='yes')return decision('yes');
  if(choices.some(c=>c.id==='no_change'))return decision('no_change');
  return decision(inputs?'stop':'move');
 },trace:async()=>{}});
 assert.equal(inputs,1);assert.notEqual(r.status,'done');assert.equal(r.reason,'replan');
}));

test('an already found item needs fresh completion evidence and sends no input',async()=>fixture(async(flow,screens)=>{
 let captures=0;
 const r=await runFlow(flow,contract,{}, {capture:async()=>{captures++;return screens[0];},choose:async(_p,choices)=>decision(choices[0].id==='yes'?'yes':'done'),execute:async()=>{throw new Error('must not input');},trace:async()=>{}});
 assert.equal(r.actions,0);assert.equal(r.status,'done');assert.ok(captures>=2);assert.equal(r.evidence[0].snapshotId,'0');
}));

test('passive waits yield at the wait budget without sending input',async()=>fixture(async(flow,screens)=>{
 flow.states[0].actions=[];flow.states[0].anchors=[];flow.states[0].maxWaits=2;
 const r=await runFlow(flow,contract,{}, {capture:async()=>screens[0],sleep:async()=>{},execute:async()=>{throw new Error('must not input');},choose:async(_prompt,choices)=>decision(choices[0].id==='yes'?'yes':'wait'),trace:async()=>{}});
 assert.equal(r.reason,'wait_budget',r.error);assert.equal(r.actions,0);
}));

test('declared state transition is followed; undeclared or ambiguous screens return without input',async()=>fixture(async(flow,screens)=>{
 flow.states[0].actions[0].next=['second'];flow.states[0].doneWhen='never';
 flow.states.push({...flow.states[0],id:'second',description:'Second screen',doneWhen:'Requested details are visible',anchors:[{box:anchor,template:await fingerprint(screens[4].path,anchor)}],actions:[]});
 let index=0;
 const r=await runFlow(flow,contract,{}, {capture:async()=>screens[index],sleep:async()=>{},execute:async()=>{index=4;},choose:async(_prompt,choices)=>{
  if(choices[0].id==='yes')return decision('yes');
  if(choices.some(c=>c.id==='other_screen'))return decision('other_screen');
  return decision(index===4?'done':'move');
 },trace:async()=>{}});
 assert.equal(r.state,'second');assert.equal(r.reason,'local_goal_observed',r.error);assert.equal(r.actions,1);
 assert.equal(r.evidence.at(-1)?.claim,'Requested details are visible');
 const unknown=await runFlow(flow,contract,{}, {capture:async()=>screens[4],choose:async()=>decision('none'),execute:async()=>{throw new Error('must not input');},trace:async()=>{}});
 assert.equal(unknown.reason,'unknown_screen');assert.equal(unknown.actions,0);
}));

test('cancellation and a window change during selection prevent input',async()=>fixture(async(flow,screens)=>{
 for(const cancel of [false,true]){
  const stop=new AbortController();let selected=false,inputs=0;
  const r=await runFlow(flow,contract,{signal:stop.signal},{capture:async()=>selected&&!cancel?{...screens[0],window:{...screens[0].window,pid:10}}:screens[0],choose:async()=>{selected=true;if(cancel)stop.abort();return decision('move');},execute:async()=>{inputs++;},trace:async()=>{}});
  assert.equal(inputs,0);assert.equal(r.reason,cancel?'cancelled':'window_changed');
 }
}));

test('working contract preserves original request and later corrections',()=>{
 assert.deepEqual(workContract([{type:'message',id:'first',message:{role:'user',content:[{type:'text',text:'Original goal'}]}},{type:'compaction',summary:'summary'},{type:'message',message:{role:'assistant',content:[]}},{type:'message',id:'last',message:{role:'user',content:'Only one'}}]),{revision:'last',requests:['Original goal','Only one']});
});
