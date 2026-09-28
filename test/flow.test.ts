// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {runFlow,workContract,type Flow} from '../src/flow.js';
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

test('saved procedure keeps ten scrolling results and completion inside the common executor',async()=>fixture(async(flow,screens)=>{
 let index=0;const events:any[]=[];flow.states[0].actions[0].amount='small';
 const r=await runFlow(flow,contract,{maxActions:20},{capture:async()=>screens[index],sleep:async()=>{},execute:async(action)=>{assert.ok(action.box&&action.to);assert.ok(Math.abs(action.to.x-(action.box.x+action.box.width/2))<=.041,'Saved small amount must survive flow execution');index++;return {};},choose:async(prompt,choices)=>{
  if(choices.some(c=>c.id==='moved'))return decision(index===10?'found':'moved');
  if(choices[0].id==='yes')return decision('yes');
  assert.match(prompt,/Stop after one/);
  return decision(index===10?'done':'move');
 },trace:async e=>{events.push(e);}});
 assert.equal(r.reason,'local_goal_observed',r.error);assert.equal(r.actions,10);assert.equal(events.filter(e=>e.event==='dispatch').length,10);
}));

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

test('passive waits use the common loop without spending candidate budget or sending input',async()=>fixture(async(flow,screens)=>{
 flow.states[0].actions=[];flow.states[0].anchors=[];
 for(const maxWaits of [2,12]){
  flow.states[0].maxWaits=maxWaits;let polls=0;
  const r=await runFlow(flow,contract,{confirmDone:2},{capture:async()=>screens[0],sleep:async()=>{},execute:async()=>{throw new Error('must not input');},choose:async(_p,choices)=>decision(choices[0].id==='yes'?'yes':++polls===11?'done':'wait'),trace:async()=>{}});
  assert.equal(r.reason,maxWaits===2?'wait_budget':'local_goal_observed',r.error);assert.equal(r.actions,0);
 }
 await assert.rejects(runFlow({...flow,states:[{...flow.states[0],actions:[{id:'click',kind:'click',label:'Button',box:roi,when:'Visible'}]}]},contract,{transientRetries:1}),/observation-only/);
}));

test('declared state transition is followed; undeclared or ambiguous screens return without input',async()=>fixture(async(flow,screens)=>{
 flow.states[0].actions[0].next=['second'];flow.states[0].doneWhen='never';
 flow.states.push({...flow.states[0],id:'second',description:'Second screen',doneWhen:'Requested details are visible',anchors:[{box:anchor,template:await fingerprint(screens[11].path,anchor)}],actions:[]});
 let index=0;
 const r=await runFlow(flow,contract,{}, {capture:async()=>screens[index],sleep:async()=>{},execute:async()=>{index=11;},choose:async(prompt,choices)=>{
  if(choices[0].id==='yes'){if(prompt.includes('Completion check'))assert.match(prompt,/Requested details/);return decision('yes');}
  if(choices.some(c=>c.id==='other_screen'))return decision('other_screen');
  return decision(index===11?'done':'move');
 },trace:async()=>{}});
 assert.equal(r.state,'second');assert.equal(r.reason,'local_goal_observed',r.error);assert.equal(r.actions,1);
 const unknown=await runFlow(flow,contract,{}, {capture:async()=>screens[11],choose:async()=>decision('none'),execute:async()=>{throw new Error('must not input');},trace:async()=>{}});
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
