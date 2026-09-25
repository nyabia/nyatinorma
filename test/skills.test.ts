// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import sharp from 'sharp';

test('skill packages retain scoped knowledge, portable evidence and presets without carrying run completion',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-skills-'));process.env.NYATINORMA_DATA_DIR=dir;
  const {appSkillId,rememberLesson,readLessons,knowledgeContext,skillPath,presetDirectory,libraryDirectory,lessonEvidence}=await import('../src/skills.js');
  const {initTasks,task,listTasks}=await import('../src/tasks.js');
  const app=await appSkillId();
  try{
    await mkdir(join(dir,'tasks'),{recursive:true});await writeFile(join(dir,'tasks','legacy.json'),JSON.stringify({id:'legacy',name:'보존한 프리셋',instructions:[],revision:4}));
    await mkdir(join(dir,'sets','legacy'),{recursive:true});await writeFile(join(dir,'sets','legacy','old.json'),'{}');
    await initTasks();assert.equal((await task('legacy')).revision,4);assert.deepEqual((await listTasks()).map(t=>t.id),['legacy']);
    assert.ok((await readFile(join(dir,'tasks','legacy.json'),'utf8')).includes('보존한'));
    assert.equal(await readFile(join(await libraryDirectory('legacy'),'old.json'),'utf8'),'{}');
    assert.ok((await presetDirectory()).startsWith(skillPath(app)));
    const general=await rememberLesson({scope:'general',title:'범용',content:'화면 변경 후에는 위치를 다시 확인한다.',status:'hypothesis'});
    await rememberLesson({scope:'app',title:'앱 공통',content:'전투 종료 화면 판독',status:'hypothesis'});
    const old=await rememberLesson({scope:'scenario',scenario:'theater',title:'극장',content:'처음 가정',status:'hypothesis'});
    await rememberLesson({scope:'scenario',scenario:'daily',title:'일일',content:'극장에는 섞이지 않아야 한다.',status:'hypothesis'});
    const fresh=await rememberLesson({scope:'scenario',scenario:'theater',title:'극장 교정',content:'교정한 절차',status:'hypothesis',supersedes:old.id});
    const context=await knowledgeContext('theater');
    assert.equal(context.lessons.general[0].id,general.id);assert.equal(context.lessons.app.length,1);assert.deepEqual(context.lessons.scenario.map(n=>n.id),[fresh.id]);
    assert.equal((await readLessons('scenario','theater',true)).length,2);assert.equal((await knowledgeContext()).lessons.scenario.length,0);
    await assert.rejects(rememberLesson({scope:'app',title:'잘못된 범위',content:'범위가 다른 교정',status:'hypothesis',supersedes:fresh.id}),/same scope/);
    await assert.rejects(rememberLesson({scope:'app',title:'근거 없음',content:'관측했다고 주장',status:'observed'}),/screenshot/);
    const snapshotId='1234567890123-1234abcd';await mkdir(join(dir,'captures'),{recursive:true});
    await sharp({create:{width:4,height:4,channels:3,background:'#124578'}}).png().toFile(join(dir,'captures',snapshotId+'.png'));
    await writeFile(join(dir,'captures',snapshotId+'.json'),JSON.stringify({id:snapshotId,path:join(dir,'captures',snapshotId+'.png'),at:1,width:4,height:4}));
    const observed=await rememberLesson({scope:'app',title:'관측 근거',content:'화면에서 확인한 조건',status:'observed',snapshotId});
    const copied=join(dir,'exported');await cp(skillPath(app),copied,{recursive:true});await rm(join(dir,'captures'),{recursive:true});
    assert.ok((await readFile(resolve(copied,observed.evidence!))).length>0);
    assert.ok((await readFile((await lessonEvidence('app',undefined,observed.id)).path)).length>0);
    assert.equal(JSON.parse(await readFile(join(copied,'evidence',snapshotId+'.json'),'utf8')).path,observed.evidence);
    await assert.rejects(readFile(join(copied,'progress.json')),{code:'ENOENT'});
  }finally{await rm(dir,{recursive:true,force:true});delete process.env.NYATINORMA_DATA_DIR;}
});
