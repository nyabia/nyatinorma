// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {locate,zoomCell,movePoint} from '../src/locate.js';
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

test('search branches preserve ancestor prefixes, backtrack and do not revisit a failed child',async()=>fixture(async s=>{
  const original=await readFile(s.path),requests:any[]=[],sequence=['no','cell-1','no','cell-9','uncertain','back','cell-2','yes'];
  const result=await locate(s,{target:'green button',constraints:'Do not click',maxSteps:12},{minMass:.5,minMargin:.2,choose:async(state,choices,_signal,image,history)=>{
    const messages=selectionHistory(state,choices,image,history);requests.push(messages);
    assert.match(messages[0].content,/Do not click/);return decision(sequence[requests.length-1]);
  }});
  assert.equal(result.reason,'located');assert.deepEqual(result.point,{x:.25,y:1/12});assert.equal(result.pixels!.x,240);
  assert.deepEqual(requests[2].slice(0,1),requests[1]);
  assert.deepEqual(requests[4].slice(0,3),requests[3]);
  assert.deepEqual(requests[6].slice(0,2),requests[3].slice(0,2));
  assert.match(requests[6].at(-1).content,/Already explored cells: I/);
  assert.ok(!JSON.stringify(result).includes('base64'));assert.deepEqual(await readFile(s.path),original);
}));

test('invalid or incomplete confirmation never returns a coordinate',async()=>fixture(async s=>{
  for(const [choice,reason] of [[null,'uncertain_selection'],['bogus','invalid_choice']] as const){
    const r=await locate(s,{target:'button'},{minMass:.5,minMargin:.2,choose:async()=>decision(choice)});
    assert.equal(r.reason,reason);assert.equal(r.point,undefined);
  }
  const budget=await locate(s,{target:'button',maxSteps:1},{minMass:.5,minMargin:.2,choose:async()=>decision('no')});
  assert.equal(budget.reason,'step_budget');assert.equal(budget.point,undefined);
  const uncertain=await locate(s,{target:'button'},{minMass:.5,minMargin:.2,choose:async()=>({...decision('yes'),truncated:true})});
  assert.equal(uncertain.reason,'uncertain_selection');assert.equal(uncertain.point,undefined);
}));

test('cancellation or human intervention after SELECT cannot return a click coordinate',async()=>fixture(async s=>{
  const controller=new AbortController();
  await assert.rejects(locate(s,{target:'button',signal:controller.signal},{minMass:.5,minMargin:.2,choose:async()=>{controller.abort();return decision('yes');}}),{name:'AbortError'});
  let pending=false;
  await assert.rejects(locate(s,{target:'button'},{minMass:.5,minMargin:.2,check:()=>{if(pending)throw new Error('new instruction');},choose:async()=>{pending=true;return decision('yes');}}),/new instruction/);
}));

test('equivalent cell scores do not compete with the independent three-way confirmation',async()=>fixture(async s=>{
  let calls=0;
  const choose=async(_state:string,choices:any[])=>{
    calls++;
    if(calls===2){assert.ok(choices.every(c=>c.id!=='yes'));return {...decision('cell-7'),margin:.001};}
    assert.deepEqual(choices.map(c=>c.id),['yes','no','uncertain']);return decision(calls===1?'no':'yes');
  };
  const result=await locate(s,{target:'lower left button'},{minMass:.5,minMargin:.2,choose});
  assert.equal(result.reason,'located');assert.equal(calls,3);assert.ok(result.point!.x<.5&&result.point!.y>.5);
  const weak=await locate(s,{target:'button',maxSteps:1},{minMass:.5,minMargin:.2,choose:async()=>({...decision('yes'),margin:.116})});
  assert.equal(weak.point,undefined);assert.equal(weak.selection?.reason,'low_confirmation_margin');
  assert.equal(weak.selection?.phase,'verify');assert.equal(weak.selection?.margin,.116);
}));

test('known top-k scores may guide a crop but incomplete confirmation still prevents a point',async()=>fixture(async s=>{
  let calls=0;
  const result=await locate(s,{target:'button'},{minMass:.5,minMargin:.2,choose:async()=>{
    calls++;
    if(calls===1)return decision('no');
    if(calls===2)return {...decision(null),reason:'incomplete_top_k',truncated:true,probabilities:{'cell-7':.4,'cell-8':.35},margin:.05};
    return {...decision(null),reason:'incomplete_top_k',truncated:true};
  }});
  assert.equal(calls,3);assert.equal(result.depth,1);assert.equal(result.reason,'uncertain_selection');assert.equal(result.point,undefined);
}));

test('an initial crop can zoom out to the full image instead of being trapped at its root',async()=>fixture(async s=>{
  let calls=0;const sequence=['no','back','yes'];
  const result=await locate(s,{target:'centre button',view:{x:0,y:0,width:.25,height:.25}},{minMass:.5,minMargin:.2,choose:async()=>decision(sequence[calls++])});
  assert.equal(result.reason,'located');assert.deepEqual(result.point,{x:.5,y:.5});assert.deepEqual(result.view,{x:0,y:0,width:1,height:1});
}));


test('fine movement keeps the view, supports smaller steps, and requires confirmation after every move',async()=>fixture(async s=>{
  const sequence=['no','move','smaller','move-right','no','move-down','yes'];let calls=0;
  const result=await locate(s,{target:'small button'},{minMass:.5,minMargin:.2,choose:async(_state,choices)=>{assert.ok(choices.length<=12);return decision(sequence[calls++]);}});
  assert.equal(result.reason,'located');assert.equal(calls,7);assert.equal(result.depth,0);
  assert.deepEqual(result.point,{x:.5625,y:.5625});assert.deepEqual(result.view,{x:0,y:0,width:1,height:1});
  const edge=movePoint(s,{x:0,y:0,width:1,height:1},{x:.9999,y:.9999},7);
  assert.ok(edge.x<1&&edge.y<1);
  let i=0;const tiny=await locate(s,{target:'tiny target',view:{x:.2,y:.2,width:.01,height:.01}},{minMass:.5,minMargin:.2,choose:async()=>decision(['no','move-right','yes'][i++])});
  assert.equal(tiny.reason,'located');assert.ok(tiny.point!.x>.205);assert.equal(tiny.depth,0);
}));

test('default budget permits twenty calls but never returns an unconfirmed moved point',async()=>fixture(async s=>{
  let calls=0,moves=0;
  const result=await locate(s,{target:'button'},{minMass:.5,minMargin:.2,choose:async(_state,choices)=>{
    calls++;return decision(choices.some(c=>c.id==='yes')?'no':choices.some(c=>c.id==='move')?'move':++moves%2?'move-right':'move-left');
  }});
  assert.equal(calls,20);assert.equal(result.selectCalls,20);assert.equal(result.reason,'step_budget');assert.equal(result.point,undefined);
}));
