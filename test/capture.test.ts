// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {normalizeCapture} from '../src/vision.js';

test('transparent ScreenCaptureKit padding is removed without OCR and black game content is preserved',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nyatinorma-capture-'));
  try {
    const path=join(dir,'window.png');
    const window=await sharp({create:{width:100,height:80,channels:4,background:{r:0,g:0,b:0,alpha:1}}}).png().toBuffer();
    await sharp({create:{width:200,height:160,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:window,left:0,top:0}]).png().toFile(path);
    const result=await normalizeCapture(path,{x:220,y:31,width:100,height:80});
    assert.equal(result.width,100);assert.equal(result.height,80);
    // An opaque black game region must remain, and repeated normalization is stable.
    assert.deepEqual(await normalizeCapture(path,{x:220,y:31,width:100,height:80}),result);
    assert.equal((await sharp(path).metadata()).width,100);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('ambiguous transparent capture fails closed before coordinates are used',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nyatinorma-capture-'));
  try {
    const path=join(dir,'window.png');
    await sharp({create:{width:200,height:160,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toFile(path);
    await assert.rejects(normalizeCapture(path,{x:0,y:0,width:100,height:80}),/fully transparent/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
