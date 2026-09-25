// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('presets, executions and conversation bindings are isolated; legacy state is never auto-selected',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-runs-'));process.env.NYATINORMA_DATA_DIR=dir;
  const {initTasks,task,defineTask}=await import('../src/tasks.js');
    const {createRun,selectRun,listRuns,migrateLegacyRuns,runPath,bindingFromBranch,configureRun}=await import('../src/runs.js');
  const {currentRun,requireFreshObservation}=await import('../src/runtime.js');
  const {progress,saveProgress,normalizeProgress,recordCheckpoint,saveSet,loadSet,publishSet}=await import('../src/store.js');
  const {writePlan,readPlan}=await import('../src/plan.js');
  try{
    await initTasks();await defineTask({id:'sample-task',name:'테스트용 절차',objective:'테스트',instructions:[],successCriteria:[]});assert.equal(currentRun(),null);await assert.rejects(task(),/기록/);
    const old={season:1,story:'기존',stage:null,attempts:{x:2},verified:{},notes:['기존 기록']};
    await writeFile(join(dir,'sample-task-progress.json'),JSON.stringify(old));
    await migrateLegacyRuns();await migrateLegacyRuns();assert.equal((await listRuns()).length,1);assert.equal(currentRun(),null);
    assert.equal((await listRuns())[0].legacy,true);await selectRun((await listRuns())[0].id);assert.deepEqual((await progress()).legacy,old);await selectRun(null);assert.deepEqual(JSON.parse(await readFile(join(dir,'sample-task-progress.json'),'utf8')),old);
    const first=await createRun('sample-task','첫 실행'),second=await createRun('sample-task','둘째 실행');
    await selectRun(first.id);assert.throws(()=>requireFreshObservation(0),/새 화면/);requireFreshObservation(Date.now()+1);
    await saveProgress(normalizeProgress(old));await writePlan(0,[{title:'첫 단계',status:'active'}],['미확인']);
    await selectRun(second.id);assert.equal((await progress()).legacy,undefined);assert.equal((await readPlan()).revision,0);
    const preset=await task('sample-task');await defineTask({...preset,name:'수정 프리셋'});assert.notEqual((await task()).name,'수정 프리셋');
    await selectRun(first.id);assert.equal((await progress()).legacy?.story,'기존');assert.equal((await readPlan()).revision,1);
    await saveSet({name:'reusable',version:1,screen:'menu',anchors:[],candidates:[],createdFrom:'test',createdAt:1});await publishSet('reusable');
    await selectRun(second.id);await assert.rejects(loadSet('reusable'),/ENOENT/);
    const third=await createRun('sample-task','셋째 실행');await selectRun(third.id);assert.equal((await loadSet('reusable')).version,1);
    await selectRun(null);assert.equal(currentRun(),null);assert.equal((await progress()).legacy,undefined);await assert.rejects(saveProgress(normalizeProgress(old)),/기록/);
    const entries=[{type:'custom',customType:'nyatinorma-run',data:{runId:first.id}}];
    assert.equal(bindingFromBranch(entries),first.id);assert.equal(bindingFromBranch([...entries,{type:'custom',customType:'nyatinorma-run',data:{runId:null}}]),null);assert.equal(bindingFromBranch([]),null);
    await writeFile(join(runPath(second.id),'owner.json'),JSON.stringify({pid:process.pid}));
    await assert.rejects(selectRun(second.id),/다른 터미널/);assert.equal(currentRun(),null);
    const anonymous=await createRun();await selectRun(anonymous.id);assert.equal(anonymous.anonymous,true);assert.equal(anonymous.preset.id,'scratch');
    await saveProgress(normalizeProgress(old));await configureRun({title:'나중에 붙인 이름',presetId:'sample-task'});
    assert.equal(currentRun()!.id,anonymous.id);assert.equal(currentRun()!.anonymous,false);assert.equal(currentRun()!.scenario,'sample-task');assert.equal((await progress()).legacy?.story,'기존');
    const snapshotId='1790000000000-1234abcd';
    await writeFile(join(dir,'captures',snapshotId+'.json'),JSON.stringify({id:snapshotId}));
    await recordCheckpoint({snapshotId,note:'페이지 상태 확인',key:'page:custom',data:{status:'read',custom:[1,'yes']},state:{position:'chapter-a'}});
    await recordCheckpoint({snapshotId,note:'후속 관측',state:{cursor:2}});
    const updated=await progress();assert.deepEqual(updated.state,{position:'chapter-a',cursor:2});assert.deepEqual(updated.checkpoints['page:custom'].data,{status:'read',custom:[1,'yes']});assert.deepEqual(updated.legacy,old);
    await assert.rejects(recordCheckpoint({snapshotId,note:'invalid',data:{x:1}}),/key/);
    await assert.rejects(recordCheckpoint({snapshotId:'1790000000000-aaaaaaaa',note:'unseen'}),/ENOENT/);
    assert.deepEqual(await progress(),updated);
  }finally{await selectRun(null);await rm(dir,{recursive:true,force:true});delete process.env.NYATINORMA_DATA_DIR;}
});
