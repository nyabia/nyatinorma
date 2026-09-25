// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {locate,zoomCell} from '../src/locate.js';
import {selectionHistory} from '../src/ollama.js';
import type {Snapshot,Decision} from '../src/types.js';
const decision=(choice:string|null):Decision=>({choice,probabilities:{},legalMass:.99,margin:.9,truncated:false,reason:'test',elapsedMs:1});
async function fixture(body:(s:Snapshot)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'ny-locate-')),path=join(dir,'screen.png');
  try{
    await sharp(Buffer.from('<svg width="960" height="640"><rect width="960" height="640" fill="#222"/><rect x="80" y="80" width="100" height="60" fill="green"/></svg>')).png().toFile(path);
    await body({id:'test',at:0,path,width:960,height:640,window:{pid:1,windowId:2,title:'Example',frame:{x:700,y:40,width:480,height:320}},ocr:[]});
  }finally{await rm(dir,{recursive:true,force:true});}
}

test('padded zoom includes neighbours, stays in its parent and preserves the selected point at edges',()=>{
  for(let cell=0;cell<9;cell++){
    const parent={x:.25,y:.25,width:.5,height:.5},r=zoomCell(parent,cell);
    assert.equal(r.view.width,.25);assert.equal(r.view.height,.25);
    assert.ok(r.view.x>=parent.x&&r.view.y>=parent.y);
    assert.ok(r.view.x+r.view.width<=.75&&r.view.y+r.view.height<=.75);
    assert.ok(r.point.x>r.view.x&&r.point.x<r.view.x+r.view.width);
  }
  assert.deepEqual(zoomCell({x:0,y:0,width:1,height:1},0),{point:{x:1/6,y:1/6},view:{x:0,y:0,width:.5,height:.5}});
});

test('zoom appends an exact prefix, backtracking restores it, only confirmation returns coordinates',async()=>fixture(async s=>{
  const original=await readFile(s.path),requests:any[]=[],sequence=['cell-1','cell-9','back','confirm'];
  const result=await locate(s,{target:'green button',constraints:'Do not click',maxSteps:6},{minMass:.5,minMargin:.2,choose:async(state,choices,_signal,image,history)=>{
    assert.equal(choices.length,12);const messages=selectionHistory(state,choices,image,history);requests.push(messages);
    assert.match(messages[0].content,/Do not click/);return decision(sequence[requests.length-1]);
  }});
  assert.equal(result.reason,'located');assert.deepEqual(result.point,{x:1/6,y:1/6});assert.equal(result.pixels!.x,160);assert.ok(Math.abs(result.pixels!.y-640/6)<1e-10);
  assert.deepEqual(requests[1].slice(0,1),requests[0]);
  assert.deepEqual(requests[2].slice(0,3),requests[1]);
  assert.deepEqual(requests[3],requests[1]); // restored parent, no changed timestamps or images
  assert.ok(!JSON.stringify(result).includes('base64'));assert.deepEqual(await readFile(s.path),original);
}));

test('abstention, resolution limit and exhausted search never leak an unconfirmed point',async()=>fixture(async s=>{
  for(const [choice,reason] of [[null,'uncertain_selection'],['think','needs_planning'],['back','target_not_located'],['bogus','invalid_choice']] as const){
    const r=await locate(s,{target:'button'},{minMass:.5,minMargin:.2,choose:async()=>decision(choice)});
    assert.equal(r.reason,reason);assert.equal(r.point,undefined);
  }
  const budget=await locate(s,{target:'button',maxSteps:1},{minMass:.5,minMargin:.2,choose:async()=>decision('cell-1')});
  assert.equal(budget.reason,'step_budget');assert.equal(budget.point,undefined);
  const tiny=await locate(s,{target:'button',view:{x:.2,y:.2,width:.01,height:.01}},{minMass:.5,minMargin:.2,choose:async()=>decision('cell-1')});
  assert.equal(tiny.reason,'resolution_limit');assert.equal(tiny.point,undefined);
  const uncertain=await locate(s,{target:'button'},{minMass:.5,minMargin:.2,choose:async()=>({...decision('confirm'),truncated:true})});
  assert.equal(uncertain.reason,'uncertain_selection');assert.equal(uncertain.point,undefined);
}));

test('cancellation or human intervention after SELECT cannot return a click coordinate',async()=>fixture(async s=>{
  const controller=new AbortController();
  await assert.rejects(locate(s,{target:'button',signal:controller.signal},{minMass:.5,minMargin:.2,choose:async()=>{controller.abort();return decision('confirm');}}),{name:'AbortError'});
  let pending=false;
  await assert.rejects(locate(s,{target:'button'},{minMass:.5,minMargin:.2,check:()=>{if(pending)throw new Error('new instruction');},choose:async()=>{pending=true;return decision('confirm');}}),/new instruction/);
}));
