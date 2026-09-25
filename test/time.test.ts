// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {readClock,localISO,parseStopAt,assertBeforeDeadline,deadlineState} from '../src/time.js';
import {currentRun} from '../src/runtime.js';

test('clock exposes offset and next local occurrence across midnight; invalid deadlines are rejected',()=>{
  const now=new Date(2026,8,26,23,40,0),clock=readClock('03:00',now.getTime());
  assert.equal(Date.parse(clock.local),now.getTime());assert.equal(Date.parse(clock.utc),now.getTime());
  assert.equal(new Date(clock.nextOccurrence!.local).getDate(),27);
  assert.equal(new Date(clock.nextOccurrence!.local).getHours(),3);
  const exact=new Date(2026,8,26,3,0,0);assert.equal(new Date(readClock('03:00',exact.getTime()).nextOccurrence!.local).getDate(),27);
  assert.equal(parseStopAt('2026-09-27T03:00:00+09:00'),Date.parse('2026-09-26T18:00:00Z'));
  assert.throws(()=>parseStopAt('2026-09-27T03:00'),/offset/);
  assert.throws(()=>parseStopAt('2026-02-30T03:00:00+09:00'),/Invalid/);
  assert.throws(()=>readClock('24:00'));assert.throws(()=>readClock('3:00'));
});

test('deadline persists per run; expired or too-long inputs are blocked, including a slow flow decision',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-clock-'));process.env.NYATINORMA_DATA_DIR=dir;
  const {createRun,selectRun,setRunDeadline,loadRun}=await import('../src/runs.js');
  const {execute}=await import('../src/desktop.js');
  const {execute:executeLegacy}=await import('../src/macos.js');
  const {executeBridgeDrag}=await import('../src/drag.js');
  const {runFlow}=await import('../src/flow.js');
  try{
    const run=await createRun();await selectRun(run.id);
    const stopAt=localISO(new Date(Date.now()+60_000));await setRunDeadline(stopAt);
    const epoch=parseStopAt(stopAt);assertBeforeDeadline(0,epoch-1);
    assert.throws(()=>assertBeforeDeadline(0,epoch),/deadline_reached/);
    assert.throws(()=>assertBeforeDeadline(2000,epoch-1000),/deadline_reached/);
    assert.equal(deadlineState(epoch)!.expired,true);
    await selectRun(null);await selectRun(run.id);assert.equal(currentRun()!.stopAt,stopAt);
    assert.equal((await loadRun(run.id)).stopAt,stopAt);
    await setRunDeadline('2000-01-01T00:00:00Z');
    // These checks run before opening either backend or dispatching input.
    await assert.rejects(execute({kind:'click'} as any,{} as any),/deadline_reached/);
    await assert.rejects(executeLegacy({kind:'click'} as any,{} as any),/deadline_reached/);
    await assert.rejects(executeBridgeDrag({kind:'drag'} as any,{} as any,1000,false,undefined,async()=>{throw new Error('must not contact driver');}),/deadline_reached/);
    await setRunDeadline(null);assertBeforeDeadline();assert.equal(deadlineState(),null);

    const path=join(dir,'example.png');await sharp({create:{width:100,height:100,channels:3,background:'#234567'}}).png().toFile(path);
    const screen={id:'example',path,at:Date.now(),width:100,height:100,ocr:[],window:{pid:1,windowId:1,title:'Example',frame:{x:0,y:0,width:100,height:100}}};
    await setRunDeadline(stopAt);
    const result=await runFlow({name:'wait-test',version:1,purpose:'Wait for a visible condition',entry:'view',createdAt:0,states:[{id:'view',snapshotId:'example',description:'Example',visualAnchors:[],progressRegion:{x:0,y:0,width:1,height:1},doneWhen:'Condition visible',actions:[]}]},{revision:'u',requests:['Stop at the specified time']},{},{capture:async()=>screen,trace:async()=>{},choose:async()=>{
      // The queued inference crosses the cutoff before returning its decision.
      currentRun()!.stopAt='2000-01-01T00:00:00Z';
      return {choice:'wait',legalMass:1,margin:1,probabilities:{wait:1},truncated:false,reason:'test',elapsedMs:1};
    },execute:async()=>{throw new Error('No input allowed');}});
    assert.equal(result.reason,'deadline_reached');assert.equal(result.actions,0);assert.equal(result.selectCalls,1);
    await setRunDeadline(null);
    const second=await createRun();await selectRun(second.id);assert.equal(currentRun()!.stopAt,undefined);
  }finally{await selectRun(null);await rm(dir,{recursive:true,force:true});delete process.env.NYATINORMA_DATA_DIR;}
});
