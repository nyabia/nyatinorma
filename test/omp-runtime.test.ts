// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {createNyatinorma,type ComputerWindow,type OmpBridges} from '../integrations/omp/runtime.js';
import {defaults,config} from '../src/config.js';
import {withExecutionHost,type ExecutionHost} from '../src/host-context.js';
import {newContinuation,saveContinuation,loadContinuation,type Continuation,type CandidateBatch} from '../src/execution-contract.js';
import {acquireInput,pendingInput,recordPendingInput} from '../src/input-lock.js';

function memoryHost(id:string,scope=id):ExecutionHost{
  const saved=new Map<string,Continuation>();let active:string|undefined;
  return {id,inputScope:scope,config:async()=>({...defaults,model:id}),loadContinuation:async(key)=>structuredClone(saved.get(key??active??'')),saveContinuation:async(value)=>{saved.set(value.id,structuredClone(value));active=value.id;},snapshot:async()=>undefined};
}
function criteriaOf(schema:unknown):Record<string,string>{
  assert.ok(schema&&typeof schema==='object'&&'decision' in schema);
  const decision=schema.decision;assert.ok(decision&&typeof decision==='object'&&'criteria' in decision);
  const criteria=decision.criteria;assert.ok(criteria&&typeof criteria==='object');
  const entries=Object.entries(criteria);assert.ok(entries.every(([,value])=>typeof value==='string'));
  return Object.fromEntries(entries);
}
function answer(schema:unknown,choice:string){
  const criteria=criteriaOf(schema);assert.ok(choice in criteria,`Unexpected choice ${choice}`);
  return {decision:{choice,probabilities:Object.fromEntries(Object.keys(criteria).map(id=>[id,id===choice?1:0]))}};
}
async function fixture(body:(f:{dir:string;win:ComputerWindow;computer:OmpBridges['computer'];getInputs:()=>number;setDispatch:(fn:()=>void)=>void})=>Promise<void>){
  const base=resolve(import.meta.dirname,'../.tmpdl/omp-tests');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'host-'));
  try{
    const paths:string[]=[];let page=0,inputs=0,dispatch=()=>{page++;};
    for(let i=0;i<4;i++){const path=resolve(dir,i+'.png');await sharp({create:{width:200,height:140,channels:3,background:{r:20+i*40,g:40,b:80}}}).png().toFile(path);paths.push(path);}
    const win:ComputerWindow={id:'window-unique',pid:50,app:'fixture',title:'Fixture',bounds:{x:10,y:20,width:400,height:280},screenshot:async()=>({path:paths[Math.min(page,3)],width:200,height:140,coordinateWidth:400,coordinateHeight:280}),click:async(x,y)=>{assert.equal(x,200);assert.equal(y,140);inputs++;dispatch();},drag:async(points)=>{assert.deepEqual(points,[[200,224],[200,56]]);inputs++;dispatch();}};
    await body({dir,win,computer:{window:async(filter)=>{if(typeof filter==='string'&&filter!==win.id)throw new Error('Missing window');return {...win,bounds:{...win.bounds}};}},getInputs:()=>inputs,setDispatch:(fn)=>{dispatch=fn;}});
  }finally{const pending=pendingInput();if(pending)recordPendingInput(pending,false);await rm(dir,{recursive:true,force:true});}
}
const click:CandidateBatch={description:'Visible blue control',actions:[{id:'open',kind:'click',label:'Open target',target:'blue target control',when:'Target visible',expectation:'Details opened',preparedAction:{id:'open',kind:'click',label:'Open target',intent:'Open',box:{x:.45,y:.45,width:.1,height:.1}}}]};
const scroll:CandidateBatch={description:'Scrollable list',actions:[{id:'scan_list',kind:'drag',label:'Scroll list',when:'Target absent',expectation:'More list content visible',drag:{surface:'list',direction:'up',amount:'large'},preparedAction:{id:'scan_list',kind:'drag',label:'Scroll list',intent:'Find target',box:{x:.45,y:.75,width:.1,height:.1},to:{x:.5,y:.2}}}]};

test('host config and continuations are isolated; unresolved input blocks another runtime sharing its input scope',async()=>{
  const scope=randomUUID(),a=memoryHost('host-a',scope),b=memoryHost('host-b',scope);
  const continuation=await withExecutionHost(a,async()=>{assert.equal((await config()).model,'host-a');const c=newContinuation({revision:'r',goal:'Goal',until:'Done',constraints:[],mode:'act'});c.lastInput={delivery:'unknown',outcome:'unresolved'};await saveContinuation(c);return c;});
  await withExecutionHost(b,async()=>{assert.equal((await config()).model,'host-b');assert.equal(await loadContinuation(),undefined);assert.throws(()=>acquireInput(),/unresolved/);});
  await withExecutionHost(a,async()=>{const release=acquireInput(continuation.id);try{continuation.lastInput={delivery:'unknown',outcome:'observed'};await saveContinuation(continuation);}finally{release();}});
});

test('OMP passive wait never generates or dispatches and stop interrupts a pending host judge; resume retains wait mode',async()=>fixture(async f=>{
  const entered=Promise.withResolvers<void>();let stopped=false;
  const ny=createNyatinorma({computer:f.computer,judge:async(_state,schema)=>{if(!stopped){entered.resolve();return Promise.withResolvers<never>().promise;}return answer(schema,'done' in criteriaOf(schema)?'done':'yes');}},{storageDir:resolve(f.dir,'session'),generate:async()=>{throw new Error('Wait must not generate candidates');}});
  const pending=ny.wait({window:f.win.id,goal:'Wait for ready',until:'Ready'});await entered.promise;stopped=true;ny.stop();
  assert.equal((await pending).reason,'cancelled');assert.equal(f.getInputs(),0);assert.equal((await ny.status()).phase,'stopped');
  const resumed=await ny.resume();assert.equal(resumed.status,'done');assert.equal(f.getInputs(),0);
}));

test('OMP reuses one prepared drag batch for repeated semantic scrolling and maps coordinate dimensions, not PNG pixels',async()=>fixture(async f=>{
  let moves=0,supplies=0;
  const ny=createNyatinorma({computer:f.computer,judge:async(_state,schema)=>{const criteria=criteriaOf(schema);return answer(schema,'scan_list' in criteria?'scan_list':'moved' in criteria?(++moves===1?'moved':'found'):'yes');}},{storageDir:resolve(f.dir,'session')});
  const result=await ny.scroll({window:f.win.id,goal:'Find target',until:'Target visible',supplier:async()=>{supplies++;return scroll;},maxActions:4});
  assert.equal(result.status,'done',result.error);assert.equal(f.getInputs(),2);assert.equal(supplies,1);assert.equal(result.lastInput.outcome,'observed');assert.ok(result.decisionRoute);
}));

test('OMP unknown dispatch survives adapter replacement and resumes by observation, never automatic replay',async()=>fixture(async f=>{
  const storageDir=resolve(f.dir,'session');let reconcile=false;
  const judge:OmpBridges['judge']=async(_state,schema)=>{const criteria=criteriaOf(schema);return answer(schema,'observed' in criteria?'observed':'open' in criteria?'open':'done' in criteria&&reconcile?'done':'yes');};
  f.setDispatch(()=>{throw new Error('Transport lost after dispatch');});
  const first=createNyatinorma({computer:f.computer,judge},{storageDir});const result=await first.act({window:f.win.id,goal:'Open target',until:'Details opened',grid_navigation:true,candidates:click});
  assert.equal(result.lastInput.delivery,'unknown');assert.equal(result.lastInput.outcome,'unresolved');assert.equal(f.getInputs(),1);
  const replacement=createNyatinorma({computer:f.computer,judge},{storageDir});
  await assert.rejects(replacement.act({window:f.win.id,goal:'Another input',grid_navigation:true,candidates:click}),/unresolved/);
  reconcile=true;
  const resumed=await replacement.resume({window:f.win.id,candidates:{description:'Details open',actions:[]}});assert.equal(resumed.status,'done',resumed.error);assert.equal(resumed.lastInput.outcome,'observed');assert.equal(f.getInputs(),1);
}));

test('OMP stop during an in-flight dispatch keeps its unknown journal and resume never replays',async()=>fixture(async f=>{
  const entered=Promise.withResolvers<void>(),released=Promise.withResolvers<void>();let inputs=0,reconcile=false;
  f.win.click=async()=>{inputs++;entered.resolve();await released.promise;throw new Error('Driver response lost');};
  const judge:OmpBridges['judge']=async(_state,schema)=>{const criteria=criteriaOf(schema);return answer(schema,'observed' in criteria?'observed':'open' in criteria?'open':'done' in criteria&&reconcile?'done':'yes');};
  const storageDir=resolve(f.dir,'dispatch-session'),ny=createNyatinorma({computer:f.computer,judge},{storageDir});
  const pending=ny.act({window:f.win.id,goal:'Open target',until:'Details open',grid_navigation:true,candidates:click});await entered.promise;ny.stop();released.resolve();
  const cancelled=await pending;assert.equal(cancelled.reason,'cancelled');assert.equal(cancelled.lastInput.delivery,'unknown');assert.equal(cancelled.lastInput.outcome,'unresolved');
  const replacement=createNyatinorma({computer:f.computer,judge},{storageDir});await assert.rejects(replacement.act({window:f.win.id,goal:'Open target',grid_navigation:true,candidates:click}),/unresolved/);
  reconcile=true;
  const resumed=await replacement.resume({window:f.win.id,candidates:{description:'Details open',actions:[]}});assert.equal(resumed.status,'done',resumed.error);assert.equal(inputs,1);
}));

test('OMP incomplete host judgment never authorizes input',async()=>fixture(async f=>{
  const ny=createNyatinorma({computer:f.computer,judge:async(_state,schema)=>{
    const ids=Object.keys(criteriaOf(schema)),choice=ids.includes('open')?'open':ids[0];
    return {decision:{choice,probabilities:{[choice]:1}}};
  }},{storageDir:resolve(f.dir,'invalid-judgment')});
  const result=await ny.act({window:f.win.id,goal:'Open target',grid_navigation:true,candidates:click});
  assert.equal(result.status,'error');assert.equal(result.lastInput.delivery,'not_sent');assert.equal(f.getInputs(),0);
}));

