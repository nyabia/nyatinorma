// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseWindow,actionArgs} from '../src/desktop.js';
import type {Snapshot} from '../src/types.js';

test('window selection excludes hidden helpers and never silently chooses among multiple visible targets',()=>{
  const target={targetApp:'Game'};
  const w={app_name:'Game',title:'Game',pid:2,window_id:3,is_on_screen:true,bounds:{x:20,y:30,width:1000,height:800}};
  assert.equal(chooseWindow([{...w,window_id:1,is_on_screen:false},w],target).windowId,3);
  assert.throws(()=>chooseWindow([w,{...w,window_id:4}],target),/여러 개/);
  assert.equal(chooseWindow([w,{...w,window_id:4}],{...target,targetWindowId:4}).windowId,4);
  assert.throws(()=>chooseWindow([{...w,app_name:'Other',title:'Other'}],target),/찾지/);
});
test('CUA uses screenshot pixels, explicit window targeting and background delivery on both click and drag',()=>{
  const s={width:2100,height:1600,window:{pid:2,windowId:3}} as Snapshot;
  const a={id:'a',label:'target',kind:'click' as const,intent:'navigate' as const,box:{x:.4,y:.4,width:.2,height:.2}};
  assert.deepEqual(actionArgs(a,s,1100),{pid:2,window_id:3,delivery_mode:'background',scope:'window',x:1050,y:800});
  const drag=actionArgs({...a,kind:'drag',to:{x:.2,y:.3}},s,1100);
  assert.deepEqual(drag,{pid:2,window_id:3,delivery_mode:'background',scope:'window',from_x:1050,from_y:800,to_x:420,to_y:480,duration_ms:1100});
});
