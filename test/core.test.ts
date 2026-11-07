// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeDecision} from '../src/ollama.js';
import {validateBox,fromCrop} from '../src/vision.js';
import {checkCandidate} from '../src/policy.js';
import {safeId} from '../src/tasks.js';
import type {Candidate} from '../src/types.js';

const response=(entries:[string,number][],token='A')=>({logprobs:[{token,top_logprobs:entries.map(([token,p])=>({token,logprob:Math.log(p)}))}]});
test('select reads a genuine token distribution and retains legal mass',()=>{
  const d=decodeDecision(response([['A',.6],[' A',.1],['B',.2],['other',.1]]),['click','think']);
  assert.equal(d.choice,'click');assert.equal(d.truncated,false);assert.ok(Math.abs(d.legalMass-.9)<1e-8);assert.ok(Math.abs(d.probabilities.click-7/9)<1e-8);
});
test('top-k truncation abstains instead of inventing missing probability',()=>{
  const d=decodeDecision(response([['A',.9],['other',.1]]),['click','think']);assert.equal(d.choice,null);assert.equal(d.truncated,true);
});
test('crop coordinates map back to full window without Retina double scaling',()=>{
  assert.deepEqual(fromCrop({x:.5,y:.25},{x:.2,y:.6,width:.4,height:.2}),{x:.4,y:.65});
  assert.throws(()=>validateBox({x:.9,y:0,width:.2,height:.1}));
});
const action:Candidate={id:'open',label:'열기',kind:'click',box:{x:.5,y:.5,width:.1,height:.1},intent:'open a container'};
test('generic mechanical checks still reject missing boxes and invalid drag coordinates',()=>{
  assert.throws(()=>checkCandidate({...action,box:undefined}),/bounding box/);
  assert.throws(()=>checkCandidate({...action,kind:'drag',to:{x:1.1,y:.5}}),/end point/);
});
test('task and set IDs cannot escape the data directory',()=>{
  assert.throws(()=>safeId('../traces'));assert.equal(safeId('theater-1'),'theater-1');
});
