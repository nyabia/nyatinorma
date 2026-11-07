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
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('nested grid regions map precise clicks without model coordinate arithmetic',async()=>{
  const {gridRegion,gridOverlay}=await import('../src/vision.js');
  assert.deepEqual(gridRegion(['C4','D3']),{x:.875,y:.6875,width:.0625,height:.0625});
  const box=gridRegion(['C4','D3']);
  assert.deepEqual({x:box.x+box.width/2,y:box.y+box.height/2},{x:.90625,y:.71875});
  const bytes=await sharp({create:{width:400,height:300,channels:3,background:'#123456'}}).png().toBuffer();
  const copy=Buffer.from(bytes),result=await gridOverlay(bytes);
  assert.deepEqual(bytes,copy); // Labels are never written onto the source used by input guards.
  const meta=await sharp(result).metadata();assert.equal(meta.width,400);assert.equal(meta.height,300);
});
