// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {fingerprint,validateVisualAnchors,matchTarget} from '../src/vision.js';

test('image-only screen guard rejects a changed screen even when the target stays identical',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-visual-'));
  const anchorBox={x:.05,y:.05,width:.4,height:.2},target={x:.6,y:.7,width:.3,height:.2};
  try{
    const render=async(name:string,invert=false)=>{
      const svg=`<svg width="400" height="300"><rect width="400" height="300" fill="#222"/><rect x="20" y="15" width="160" height="60" fill="${invert?'black':'white'}"/><rect x="20" y="15" width="80" height="60" fill="${invert?'white':'black'}"/><rect x="240" y="210" width="120" height="60" fill="white"/><circle cx="300" cy="240" r="20" fill="black"/></svg>`;
      const path=join(dir,name+'.png');await sharp(Buffer.from(svg)).png().toFile(path);return path;
    };
    const original=await render('original'),changed=await render('changed',true);
    const anchors=[{box:anchorBox,template:await fingerprint(original,anchorBox)}];
    await validateVisualAnchors(anchors,original,.12);
    assert.equal((await matchTarget(changed,target,await fingerprint(original,target),400,300)).delta,0);
    await assert.rejects(validateVisualAnchors(anchors,changed,.12),/changed/);
    await assert.rejects(validateVisualAnchors([],original,.12),/Missing/);
    const flat={box:{x:0,y:.4,width:.4,height:.2},template:Buffer.alloc(768,34).toString('base64')};
    await assert.rejects(validateVisualAnchors([flat],original,.12),/uniform/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('nested grid regions map precise clicks without model coordinate arithmetic',async()=>{
  const {gridRegion,gridOverlay}=await import('../src/vision.js');
  assert.deepEqual(gridRegion(['C4','D3']),{x:.875,y:.6875,width:.0625,height:.0625});
  const box=gridRegion(['C4','D3']);
  assert.deepEqual({x:box.x+box.width/2,y:box.y+box.height/2},{x:.90625,y:.71875});
  assert.throws(()=>gridRegion(['E1']),/A1/);
  assert.throws(()=>gridRegion(['A1','A1','A1','A1','A1']),/four/);
  const bytes=await sharp({create:{width:400,height:300,channels:3,background:'#123456'}}).png().toBuffer();
  const copy=Buffer.from(bytes),result=await gridOverlay(bytes);
  assert.deepEqual(bytes,copy); // Labels are never written onto the source used by input guards.
  const meta=await sharp(result).metadata();assert.equal(meta.width,400);assert.equal(meta.height,300);
});

test('viewing clips oversized crops while input boxes still reject overflow',async()=>{
  const {observationBox,validateBox}=await import('../src/vision.js');
  const proposed={x:.8,y:.9,width:.3,height:.2};const clipped=observationBox(proposed);
  assert.equal(clipped.x+clipped.width,1);assert.equal(clipped.y+clipped.height,1);
  assert.throws(()=>validateBox(proposed));assert.throws(()=>observationBox({...proposed,x:1}));
});

test('point targets keep the exact click centre even near window edges',async()=>{
  const {pointBox,validateBox}=await import('../src/vision.js');
  for(const p of [{x:.815,y:.942},{x:.999,y:.999},{x:.001,y:.001}]){
    const b=pointBox(p,1051,820);validateBox(b);
    assert.ok(Math.abs(b.x+b.width/2-p.x)<1e-12);
    assert.ok(Math.abs(b.y+b.height/2-p.y)<1e-12);
  }
  assert.throws(()=>pointBox({x:1.1,y:.5},1051,820));
  assert.throws(()=>pointBox({x:NaN,y:.5},1051,820));
});
