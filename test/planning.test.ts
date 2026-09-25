// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan} from '../src/plan.js';
import {nextSetVersion} from '../src/store.js';

test('plans distinguish unknown, blocked and evidenced completion without multiple active steps',()=>{
  assert.doesNotThrow(()=>validatePlan([{title:'별 확인',status:'active'},{title:'다음 카드',status:'pending'}],['화면 밖 전투 별 미확인']));
  assert.throws(()=>validatePlan([{title:'전투 완료',status:'done'}],[]),/snapshotId/);
  assert.throws(()=>validatePlan([{title:'a',status:'active'},{title:'b',status:'active'}],[]),/one/);
  assert.throws(()=>validatePlan([{title:'a',status:'blocked'}],[]),/reason/);
  assert.throws(()=>validatePlan([{title:'a',status:'pending'},{title:'a',status:'pending'}],[]),/unique/);
  assert.doesNotThrow(()=>validatePlan([{title:'a',status:'done',snapshotId:'observed'},{title:'b',status:'blocked',note:'로그인 화면'}],['미확인 항목']));
});

test('set revisions survive retirement and rollback without reusing historical versions',()=>{
  const files=['back.v1.json','back.v8.json','back.v3.json','back-other.v90.json','back.vbad.json'];
  assert.equal(nextSetVersion('back',files),9); // active back.json intentionally absent
  assert.equal(nextSetVersion('new',files),1);
  assert.throws(()=>nextSetVersion('../back',files),/ID/);
});
