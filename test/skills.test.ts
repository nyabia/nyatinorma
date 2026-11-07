// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import sharp from 'sharp';

test('skills retain scoped knowledge and portable evidence without run completion',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-skills-'));process.env.NYATINORMA_DATA_DIR=dir;
  // Import after selecting the fixture directory to isolate module initialization.
  const {appSkillId,rememberLesson,knowledgeContext,skillPath,lessonEvidence}=await import('../src/skills.js');
  const app=await appSkillId();
  try{
    const general=await rememberLesson({scope:'general',title:'범용',content:'화면 변경 후에는 위치를 다시 확인한다.',status:'hypothesis'});
    await rememberLesson({scope:'app',title:'앱 공통',content:'전투 종료 화면 판독',status:'hypothesis'});
    const scenario=await rememberLesson({scope:'scenario',scenario:'theater',title:'극장',content:'확인한 절차',status:'hypothesis'});
    await rememberLesson({scope:'scenario',scenario:'daily',title:'일일',content:'극장에는 섞이지 않아야 한다.',status:'hypothesis'});
    const context=await knowledgeContext('theater');
    assert.equal(context.lessons.general[0].id,general.id);assert.equal(context.lessons.app.length,1);assert.deepEqual(context.lessons.scenario.map(n=>n.id),[scenario.id]);
    assert.equal((await knowledgeContext()).lessons.scenario.length,0);
    const snapshotId='1234567890123-1234abcd';await mkdir(join(dir,'captures'),{recursive:true});
    await sharp({create:{width:4,height:4,channels:3,background:'#124578'}}).png().toFile(join(dir,'captures',snapshotId+'.png'));
    await writeFile(join(dir,'captures',snapshotId+'.json'),JSON.stringify({id:snapshotId,path:join(dir,'captures',snapshotId+'.png'),at:1,width:4,height:4}));
    const observed=await rememberLesson({scope:'app',title:'관측 근거',content:'화면에서 확인한 조건',status:'observed',snapshotId});
    const copied=join(dir,'exported');await cp(skillPath(app),copied,{recursive:true});await rm(join(dir,'captures'),{recursive:true});
    assert.ok((await readFile(resolve(copied,observed.evidence!))).length>0);
    assert.ok((await readFile((await lessonEvidence('app',undefined,observed.id)).path)).length>0);
    await assert.rejects(readFile(join(copied,'progress.json')),{code:'ENOENT'});
  }finally{await rm(dir,{recursive:true,force:true});delete process.env.NYATINORMA_DATA_DIR;}
});
