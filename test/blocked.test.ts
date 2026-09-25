// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('explicit blocked report survives resume and edits; input is blocked until human resume without losing deadlines',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-block-'));process.env.NYATINORMA_DATA_DIR=dir;
  const {createRun,selectRun,blockRun,setRunStatus,setRunDeadline,loadRun,configureRun}=await import('../src/runs.js');
  const {currentRun,requireFreshObservation}=await import('../src/runtime.js');
  const {assertCanExecute}=await import('../src/execution-state.js');
  const {execute}=await import('../src/desktop.js');
  const {execute:legacy}=await import('../src/macos.js');
  const {executeBridgeDrag}=await import('../src/drag.js');
  try{
    const run=await createRun();await selectRun(run.id);
    const stopAt='2099-01-01T00:00:00Z';await setRunDeadline(stopAt);
    await assert.rejects(blockRun({reason:' ',attempts:[],needed:'help'}),/concrete reason/);
    assert.equal(currentRun()!.status,'ready');
    await blockRun({reason:'Required access unavailable',attempts:[],needed:'User enables access',progress:'Inspected available controls'});
    assert.equal((await loadRun(run.id)).status,'blocked');
    assert.deepEqual(currentRun()!.blocked!.attempts,[]); // No mandatory retries before declaring an impossible prerequisite.
    assert.throws(()=>assertCanExecute(),/run_blocked/);
    await assert.rejects(execute({kind:'click'} as any,{} as any),/run_blocked/);
    await assert.rejects(legacy({kind:'click'} as any,{} as any),/run_blocked/);
    await assert.rejects(executeBridgeDrag({kind:'drag'} as any,{} as any,1000,false,undefined,async()=>{throw new Error('must not contact driver');}),/run_blocked/);
    await configureRun({title:'Blocked task'});assert.equal(currentRun()!.status,'blocked');
    await selectRun(null);await selectRun(run.id);assert.throws(()=>assertCanExecute(),/run_blocked/);
    await setRunStatus('ready');assertCanExecute();
    assert.equal(currentRun()!.stopAt,stopAt);assert.ok(currentRun()!.blocked!.resumedAt);
    assert.equal(currentRun()!.blocked!.reason,'Required access unavailable');
    assert.throws(()=>requireFreshObservation(0),/새 화면/);
    requireFreshObservation(Date.now()+1);
  }finally{await selectRun(null);await rm(dir,{recursive:true,force:true});delete process.env.NYATINORMA_DATA_DIR;}
});
