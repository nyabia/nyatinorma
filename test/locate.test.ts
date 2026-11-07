// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {locate,type LocateStep,type LocateDeps} from '../src/locate.js';
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
  assert.equal(steps[6].depth,1);assert.equal(steps[7].depth,2);
  assert.notDeepEqual(steps[7].point,steps[4].point,'A failed child must not be revisited even if SELECT proposes it again');
  assert.deepEqual(steps.at(-1)!.point,steps[7].point,'Detail confirmation must not substitute a new coordinate');
  assert.ok(!JSON.stringify(result).includes('base64'));assert.deepEqual(await readFile(s.path),original);
}));


test('cancellation or human intervention after SELECT cannot return a click coordinate',async()=>fixture(async s=>{
  const controller=new AbortController();
  await assert.rejects(locate(s,{target:'button',signal:controller.signal},{minMass:.5,minMargin:.2,choose:async()=>{controller.abort();return decision('yes');}}),{name:'AbortError'});
  let pending=false;
  await assert.rejects(locate(s,{target:'button'},{minMass:.5,minMargin:.2,check:()=>{if(pending)throw new Error('new instruction');},choose:async()=>{pending=true;return decision('yes');}}),/new instruction/);
}));


test('a coarse YES cannot authorize an unconfirmed detail point, and rejected detail can be refined',async()=>fixture(async s=>{
  const result=await locate(s,{target:'small button'},{minMass:.5,minMargin:.2,choose:scripted(['yes',{...decision('yes'),truncated:true}])});
  assert.equal(result.reason,'uncertain_selection');assert.equal(result.point,undefined);
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
}));

