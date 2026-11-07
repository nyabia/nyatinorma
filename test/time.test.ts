// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readClock,localISO} from '../src/time.js';
import {currentRun} from '../src/runtime.js';

test('clock resolves the next local occurrence across midnight',()=>{
  const now=new Date(2026,8,26,23,40,0),clock=readClock('03:00',now.getTime());
  assert.equal(Date.parse(clock.local),now.getTime());assert.equal(Date.parse(clock.utc),now.getTime());
  assert.equal(new Date(clock.nextOccurrence!.local).getDate(),27);
  assert.equal(new Date(clock.nextOccurrence!.local).getHours(),3);
});

test('run deadlines persist and prevent input after expiry',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-clock-'));process.env.NYATINORMA_DATA_DIR=dir;
  // Import after selecting the fixture directory to isolate module initialization.
  const {createRun,selectRun,setRunDeadline,loadRun}=await import('../src/runs.js');
  const {execute}=await import('../src/desktop.js');
  try{
    const run=await createRun();await selectRun(run.id);
    const stopAt=localISO(new Date(Date.now()+60_000));await setRunDeadline(stopAt);
    await selectRun(null);await selectRun(run.id);assert.equal(currentRun()!.stopAt,stopAt);
    assert.equal((await loadRun(run.id)).stopAt,stopAt);
    await setRunDeadline('2000-01-01T00:00:00Z');
    // The deadline guard runs before opening the backend or dispatching input.
    await assert.rejects(execute({kind:'click'} as any,{} as any),/deadline_reached/);
    await setRunDeadline(null);
    const second=await createRun();await selectRun(second.id);assert.equal(currentRun()!.stopAt,undefined);
  }finally{await selectRun(null);await rm(dir,{recursive:true,force:true});delete process.env.NYATINORMA_DATA_DIR;}
});
