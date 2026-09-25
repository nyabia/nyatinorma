// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeDragArgs,executeBridgeDrag} from '../src/drag.js';
import type {Snapshot,Candidate} from '../src/types.js';

const snapshot={width:2102,height:1640,window:{pid:2,windowId:3,title:'Game',frame:{x:15,y:38,width:1051,height:820}}} as Snapshot;
const action:Candidate={id:'drag',label:'pan',kind:'drag',intent:'navigate',box:{x:.79,y:.89,width:.02,height:.02},to:{x:.2,y:.9}};
test('separate drag adapter uses normalized full-window coordinates and refuses a different window or padded capture',()=>{
  const args=bridgeDragArgs(action,snapshot,snapshot.window,1100,true);
  assert.equal(args.action,'drag');assert.equal(args.inputMode,'background');assert.equal(args.x,.8);assert.equal(args.toX,.2);assert.equal(args.windowId,3);
  assert.throws(()=>bridgeDragArgs(action,snapshot,{...snapshot.window,pid:4},1100,true),/disagree/);
  assert.throws(()=>bridgeDragArgs(action,snapshot,{...snapshot.window,frame:{...snapshot.window.frame,x:17}},1100,true),/disagree/);
  assert.throws(()=>bridgeDragArgs(action,{...snapshot,height:1700},snapshot.window,1100,true),/aspect ratio/);
  assert.throws(()=>bridgeDragArgs({...action,kind:'click'},snapshot,snapshot.window,1100,true),/Drag requires/);
});
test('separate drag checks permissions and identity, sends only drag, and cancellation prevents dispatch',async()=>{
  const calls:Record<string,unknown>[]=[];const controller=new AbortController();let abortBeforeInput=false;
  const native=async(p:Record<string,unknown>)=>{
    calls.push(p);
    if(p.action==='doctor')return {accessibility:true,screenRecording:true,capabilities:{windowRoutedInput:true}};
    if(p.action==='window'){if(abortBeforeInput)controller.abort();return {window:snapshot.window};}
    return {ok:true,cursorDistance:0,focusPreserved:true};
  };
  const result=await executeBridgeDrag(action,snapshot,1100,true,undefined,native);
  assert.equal(result.driver,'macos-bridge');assert.deepEqual(calls.map(p=>p.action),['doctor','window','drag']);
  calls.length=0;abortBeforeInput=true;
  await assert.rejects(executeBridgeDrag(action,snapshot,1100,true,controller.signal,native),/abort/i);
  assert.deepEqual(calls.map(p=>p.action),['doctor','window']);
  calls.length=0;
  await assert.rejects(executeBridgeDrag(action,snapshot,1100,true,undefined,async p=>{calls.push(p);return {accessibility:false};}),/permissions/);
  assert.deepEqual(calls.map(p=>p.action),['doctor']);
});
