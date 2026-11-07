// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {nextSetVersion} from '../src/store.js';

test('set revisions survive retirement and rollback without reusing historical versions',()=>{
  const files=['back.v1.json','back.v8.json','back.v3.json','back-other.v90.json','back.vbad.json'];
  assert.equal(nextSetVersion('back',files),9); // active back.json intentionally absent
  assert.equal(nextSetVersion('new',files),1);
});
