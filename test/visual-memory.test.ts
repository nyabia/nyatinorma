// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {VisualMemory} from '../src/visual-memory.js';
import type {Snapshot} from '../src/types.js';

test('scan remembers nonadjacent visits without accumulating model image history',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ny-memory-'));
 try{
  const frames:Snapshot[]=[];
  for(let i=0;i<3;i++){const path=join(dir,i+'.png');await sharp({create:{width:80,height:60,channels:3,background:`rgb(${i*100},${i*100},${i*100})`}}).png().toFile(path);frames.push({id:String(i),path,at:0,width:80,height:60,ocr:[],window:{pid:1,windowId:2,title:'list',frame:{x:0,y:0,width:80,height:60}}});}
  const memory=new VisualMemory({x:0,y:0,width:1,height:1});
  for(const f of frames)assert.equal((await memory.observe(f)).info.revisited,false);
  const recurrence=await memory.observe({...frames[0],id:'new-capture'});
  assert.equal(recurrence.info.revisited,true);assert.equal(recurrence.info.distinctViews,3);assert.equal(recurrence.info.closestSnapshotId,'0');
  const restored=new VisualMemory({x:0,y:0,width:1,height:1},100,memory.serialize());assert.equal((await restored.observe(frames[1])).info.revisited,true);
  const image=await memory.comparison(frames[2],recurrence.reference);assert.ok((await sharp(Buffer.from(image,'base64')).metadata()).height!>60);
 }finally{await rm(dir,{recursive:true,force:true});}
});
