// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {locate,zoomCell,movePoint,type LocateStep,type LocateDeps} from '../src/locate.js';
import {selectionHistory} from '../src/ollama.js';
import type {Snapshot,Decision} from '../src/types.js';
import {dataDir} from '../src/config.js';
const decision=(choice:string|null):Decision=>({choice,probabilities:{},legalMass:.99,margin:.9,truncated:false,reason:'test',elapsedMs:1});
function scripted(sequence:(string|Decision)[]):LocateDeps['choose']{
  let next=0;
  return async(_state,choices)=>{
    const answer=sequence[next++];
    assert.ok(answer!==undefined,'Unexpected selection after the scripted visual decisions');
    const result=typeof answer==='string'?decision(answer):answer;
    assert.ok(choices.some(c=>c.id===result.choice),'Scripted choice must belong to the current decision');
    return result;
  };
}
async function fixture(body:(s:Snapshot)=>Promise<void>){
  await mkdir(join(dataDir,'test-tmp'),{recursive:true});
  const dir=await mkdtemp(join(dataDir,'test-tmp','ny-locate-')),path=join(dir,'screen.png');
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
  const original=await readFile(s.path),requests:{role:string;content:string;images?:string[]}[][]=[],steps:LocateStep[]=[];
  const choose=scripted(['no','cell-1','no','cell-9','uncertain','back',
    {...decision('cell-9'),probabilities:{'cell-9':.9,'cell-2':.1}},'yes','yes']);
  const result=await locate(s,{target:'green button',constraints:'Do not click',maxSteps:12},{minMass:.5,minMargin:.2,choose:async(state,choices,signal,image,history)=>{
    requests.push(selectionHistory(state,choices,image,history));
    return choose(state,choices,signal,image,history);
  },onStep:async step=>{steps.push(step);}});
  assert.equal(result.reason,'located');assert.deepEqual(result.point,{x:.25,y:1/12});assert.equal(result.pixels!.x,240);
  assert.deepEqual(requests[2].slice(0,1),requests[1]);
  assert.deepEqual(requests[4].slice(0,3),requests[3]);
  assert.deepEqual(requests[6].slice(0,2),requests[3].slice(0,2));
  assert.equal(steps[6].depth,1);assert.equal(steps[7].depth,2);
  assert.notDeepEqual(steps[7].point,steps[4].point,'A failed child must not be revisited even if SELECT proposes it again');
  assert.deepEqual(steps.at(-1)!.point,steps[7].point,'Detail confirmation must not substitute a new coordinate');
  assert.equal(requests.at(-1)!.length,1,'Exact-point detail confirmation has an independent branch');
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
  const steps:LocateStep[]=[];
  const result=await locate(s,{target:'lower left button'},{minMass:.5,minMargin:.2,
    choose:scripted(['no',{...decision('cell-7'),margin:.001},'yes','yes']),onStep:async step=>{steps.push(step);}});
  assert.equal(result.reason,'located');assert.ok(result.point!.x<.5&&result.point!.y>.5);
  const confirmations=steps.filter(step=>step.phase==='verify'&&step.decision.choice==='yes');
  assert.ok(confirmations.length>=2);
  assert.ok(confirmations.every(step=>step.choices.map(c=>c.id).join(',')==='yes,no,uncertain'));
  assert.deepEqual(confirmations[0].point,confirmations.at(-1)!.point);
  assert.ok(confirmations.at(-1)!.view.width<confirmations[0].view.width);
  const weak=await locate(s,{target:'button',maxSteps:1},{minMass:.5,minMargin:.2,choose:async()=>({...decision('yes'),margin:.116})});
  assert.equal(weak.point,undefined);assert.equal(weak.selection?.reason,'low_confirmation_margin');
  assert.equal(weak.selection?.phase,'verify');assert.equal(weak.selection?.margin,.116);
}));

test('a coarse YES cannot authorize an unconfirmed detail point, and rejected detail can be refined',async()=>fixture(async s=>{
  for(const answer of [
    {...decision('yes'),truncated:true},
    {...decision('yes'),legalMass:.1},
  ]){
    const result=await locate(s,{target:'small button'},{minMass:.5,minMargin:.2,choose:scripted(['yes',answer])});
    assert.equal(result.reason,'uncertain_selection');assert.equal(result.point,undefined);
  }
  const rejected=await locate(s,{target:'small button'},{minMass:.5,minMargin:.2,choose:scripted(['yes','no','think'])});
  assert.equal(rejected.reason,'needs_planning');assert.equal(rejected.point,undefined);
  const steps:LocateStep[]=[];
  const refined=await locate(s,{target:'small button'},{minMass:.5,minMargin:.2,
    choose:scripted(['yes','no','move','move-left','yes']),onStep:async step=>{steps.push(step);}});
  assert.equal(refined.reason,'located');
  assert.ok(refined.point!.x<.5);assert.equal(refined.point!.y,.5);
  assert.deepEqual(refined.point,steps.at(-1)!.point);
  assert.equal(steps.at(-1)!.phase,'verify');assert.equal(steps.at(-1)!.decision.choice,'yes');
  assert.deepEqual(steps[1].point,steps[0].point,'Detail must inspect the same coarse proposal before moving it');
}));

test('known top-k scores may guide a crop but incomplete confirmation still prevents a point',async()=>fixture(async s=>{
  let calls=0;
  const result=await locate(s,{target:'button'},{minMass:.5,minMargin:.2,choose:async()=>{
    calls++;
    if(calls===1)return decision('no');
    if(calls===2)return {...decision(null),reason:'incomplete_top_k',truncated:true,probabilities:{'cell-7':.4,'cell-8':.35},margin:.05};
    return {...decision(null),reason:'incomplete_top_k',truncated:true};
  }});
  assert.equal(result.depth,1);assert.equal(result.reason,'uncertain_selection');assert.equal(result.point,undefined);
}));

test('an initial crop can zoom out to the full image instead of being trapped at its root',async()=>fixture(async s=>{
  const steps:LocateStep[]=[];
  const result=await locate(s,{target:'centre button',view:{x:0,y:0,width:.25,height:.25}},{minMass:.5,minMargin:.2,
    choose:scripted(['no','back','yes','yes']),onStep:async step=>{steps.push(step);}});
  assert.equal(result.reason,'located');assert.deepEqual(result.point,{x:.5,y:.5});
  assert.deepEqual(steps.find(step=>step.decision.choice==='yes')!.view,{x:0,y:0,width:1,height:1});
  assert.deepEqual(steps.at(-1)!.point,result.point);
}));

test('drag start verification asks about the surface and can escape a wrong crop',async()=>fixture(async s=>{
  const steps:LocateStep[]=[];
  const result=await locate(s,{target:'scrollable list',purpose:'drag-start',view:{x:0,y:0,width:.25,height:.25}},{minMass:.5,minMargin:.2,
    choose:scripted(['no','back','yes']),onStep:async step=>{steps.push(step);}});
  assert.equal(result.reason,'located');assert.deepEqual(result.view,{x:0,y:0,width:1,height:1});
  assert.deepEqual(result.point,{x:.5,y:.5});
  assert.ok(steps.every(step=>step.point.x>=0&&step.point.x<=1&&step.point.y>=0&&step.point.y<=1));
}));


test('fine movement keeps the view, supports smaller steps, and requires confirmation after every move',async()=>fixture(async s=>{
  const steps:LocateStep[]=[];
  const result=await locate(s,{target:'small button'},{minMass:.5,minMargin:.2,
    choose:scripted(['no','move','smaller','move-right','no','move-down','yes','yes']),onStep:async step=>{steps.push(step);}});
  assert.equal(result.reason,'located');
  assert.deepEqual(result.point,{x:.5625,y:.5625});
  const moved=steps.filter(step=>step.phase==='verify');
  assert.deepEqual(moved.slice(0,-1).map(step=>step.point),[{x:.5,y:.5},{x:.5625,y:.5},{x:.5625,y:.5625}]);
  assert.ok(moved.slice(0,-1).every(step=>step.depth===0&&step.view.width===1&&step.view.height===1));
  assert.deepEqual(moved.at(-1)!.point,result.point,'The final close-up confirms the same moved point');
  const edge=movePoint(s,{x:0,y:0,width:1,height:1},{x:.9999,y:.9999},7);
  assert.ok(edge.x<1&&edge.y<1);
  const tiny=await locate(s,{target:'tiny target',view:{x:.2,y:.2,width:.01,height:.01}},{minMass:.5,minMargin:.2,choose:scripted(['no','move-right','yes'])});
  assert.equal(tiny.reason,'located');assert.ok(tiny.point!.x>.205);assert.equal(tiny.depth,0);
}));

test('default budget permits twenty calls but never returns an unconfirmed moved point',async()=>fixture(async s=>{
  let calls=0,moves=0;
  const result=await locate(s,{target:'button'},{minMass:.5,minMargin:.2,choose:async(_state,choices)=>{
    calls++;return decision(choices.some(c=>c.id==='yes')?'no':choices.some(c=>c.id==='move')?'move':++moves%2?'move-right':'move-left');
  }});
  assert.equal(calls,20);assert.equal(result.selectCalls,20);assert.equal(result.reason,'step_budget');assert.equal(result.point,undefined);
}));
