// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {gridPoint,resolveTarget,resolveDestination,previewTarget} from '../src/targeting.js';
import type {Snapshot} from '../src/types.js';

test('cell-local positions and nested paths resolve without screen-origin or resolution dependence',()=>{
  assert.deepEqual(gridPoint({regionPath:['C2'],x:.6,y:.4}),{x:.4,y:.6});
  const p=gridPoint({regionPath:['C4','D3'],x:.2,y:.8});
  assert.ok(Math.abs(p.x-.8875)<1e-12);assert.ok(Math.abs(p.y-.7375)<1e-12);
  for(const [width,height] of [[400,300],[2102,1640]]){
    const result=resolveTarget({gridPoint:{regionPath:['C2'],x:.6,y:.4}},width,height);
    assert.ok(Math.abs(result.point.x-.4)<1e-12);assert.ok(Math.abs(result.point.y-.6)<1e-12);
  }
  assert.deepEqual(resolveDestination({toGridPoint:{regionPath:['B1'],x:.2,y:.8}}),{x:.05,y:.45});
  assert.throws(()=>gridPoint({regionPath:['E1'],x:.5,y:.5}));
  assert.throws(()=>gridPoint({regionPath:[],x:.5,y:.5}));
  assert.throws(()=>gridPoint({regionPath:['A1'],x:NaN,y:.5}));
  assert.throws(()=>gridPoint({regionPath:['A1'],x:1.1,y:.5}));
  assert.throws(()=>resolveTarget({point:{x:.5,y:.5},gridPoint:{regionPath:['A1'],x:.5,y:.5}},400,300),/exactly one/);
  assert.throws(()=>resolveTarget({gridPoint:{regionPath:['A1'],x:0,y:0}},400,300),/strictly inside/);
  assert.throws(()=>resolveDestination({to:{x:.5,y:.5},toGridPoint:{regionPath:['A1'],x:.5,y:.5}}),/only one/);
});

test('preview marks the resolved pixel; reusable set and flow use the same point without editing capture',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-target-'));process.env.NYATINORMA_DATA_DIR=dir;
  const {createRun,selectRun}=await import('../src/runs.js');
  const {defineSet}=await import('../src/runner.js');
  const {defineFlow}=await import('../src/flow.js');
  try{
    await selectRun((await createRun()).id);await mkdir(join(dir,'captures'),{recursive:true});
    const id='1790000000000-1234abcd',path=join(dir,'captures',id+'.png');
    await sharp(Buffer.from('<svg width="400" height="300"><rect width="400" height="300" fill="#222"/><rect width="80" height="60" fill="white"/></svg>')).png().toFile(path);
    const s:Snapshot={id,path,at:Date.now()+1,width:400,height:300,ocr:[],window:{pid:1,windowId:2,title:'Example',frame:{x:950,y:-120,width:200,height:150}}};
    await writeFile(join(dir,'captures',id+'.json'),JSON.stringify(s));
    const original=await readFile(path),input={gridPoint:{regionPath:['C2'],x:.6,y:.4},toGridPoint:{regionPath:['B1'],x:.2,y:.8}};
    const preview=await previewTarget(s,input);
    assert.equal(preview.metadata.previewOnly,true);assert.deepEqual(preview.metadata.pixels,{x:160,y:180});
    const {data,info}=await sharp(preview.images[0]).removeAlpha().raw().toBuffer({resolveWithObject:true});
    assert.deepEqual([...data.subarray((180*info.width+160)*info.channels,(180*info.width+160)*info.channels+3)],[255,64,128]);
    assert.equal((await sharp(preview.images[1]).metadata()).width,800);
    const anchor={x:0,y:0,width:.4,height:.2};
    const set=await defineSet({name:'test-grid',screen:'Example',snapshotId:id,visualAnchors:[anchor],candidates:[{id:'move',label:'move',kind:'drag',intent:'inspect',...input}]},false);
    assert.deepEqual(set.candidates[0].box,preview.metadata.box);assert.deepEqual(set.candidates[0].to,preview.metadata.to);
    const flow=await defineFlow({name:'test-flow',purpose:'Inspect',entry:'view',states:[{id:'view',description:'Example',snapshotId:id,visualAnchors:[anchor],progressRegion:{x:0,y:.4,width:1,height:.6},doneWhen:'Requested state is visible',actions:[{id:'move',kind:'drag',label:'move',when:'Item not visible',...input}]}]});
    assert.deepEqual(flow.states[0].actions[0].box,preview.metadata.box);assert.deepEqual(flow.states[0].actions[0].to,preview.metadata.to);
    assert.deepEqual(await readFile(path),original);assert.equal(s.at,JSON.parse(await readFile(join(dir,'captures',id+'.json'),'utf8')).at);
  }finally{await selectRun(null);await rm(dir,{recursive:true,force:true});delete process.env.NYATINORMA_DATA_DIR;}
});
