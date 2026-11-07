// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('execution progress, plans and conversation bindings stay isolated',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-runs-'));process.env.NYATINORMA_DATA_DIR=dir;
  // Import after selecting the fixture directory to isolate module initialization.
  const {initTasks,defineTask}=await import('../src/tasks.js');
  const {createRun,selectRun,bindingFromBranch}=await import('../src/runs.js');
  const {currentRun}=await import('../src/runtime.js');
  const {progress,saveProgress,normalizeProgress}=await import('../src/store.js');
  const {writePlan,readPlan}=await import('../src/plan.js');
  try{
    await initTasks();await defineTask({id:'sample-task',name:'테스트용 절차',objective:'테스트',instructions:[],successCriteria:[]});
    const old={season:1,story:'기존',stage:null,attempts:{x:2},verified:{},notes:['기존 기록']};
    const first=await createRun('sample-task','첫 실행'),second=await createRun('sample-task','둘째 실행');
    await selectRun(first.id);
    await saveProgress(normalizeProgress(old));await writePlan(0,[{title:'첫 단계',status:'active'}],['미확인']);
    await selectRun(second.id);assert.equal((await progress()).legacy,undefined);assert.equal((await readPlan()).revision,0);
    await selectRun(first.id);assert.equal((await progress()).legacy?.story,'기존');assert.equal((await readPlan()).revision,1);
    await selectRun(null);assert.equal(currentRun(),null);assert.equal((await progress()).legacy,undefined);await assert.rejects(saveProgress(normalizeProgress(old)),/기록/);
    const entries=[{type:'custom',customType:'nyatinorma-run',data:{runId:first.id}}];
    assert.equal(bindingFromBranch(entries),first.id);assert.equal(bindingFromBranch([...entries,{type:'custom',customType:'nyatinorma-run',data:{runId:null}}]),null);
  }finally{await selectRun(null);await rm(dir,{recursive:true,force:true});delete process.env.NYATINORMA_DATA_DIR;}
});
