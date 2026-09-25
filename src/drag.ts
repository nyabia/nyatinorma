// SPDX-License-Identifier: MIT OR Apache-2.0
import {native,backgroundEventOptions} from './macos.js';
import type {Candidate,Snapshot,WindowInfo} from './types.js';
import {assertCanExecute} from './execution-state.js';

// Narrow adapter: only drag is dispatched here. Capture/click remain with Cua.
export function bridgeDragArgs(action:Candidate,s:Snapshot,actual:WindowInfo,duration:number,showPointer:boolean){
  if(action.kind!=='drag'||!action.box||!action.to)throw new Error('Drag requires observed start and end points.');
  if(actual.pid!==s.window.pid||actual.windowId!==s.window.windowId||(['x','y','width','height'] as const).some(k=>Math.abs(actual.frame[k]-s.window.frame[k])>=1))throw new Error('Cua and drag bridge disagree on the target window; reobserve.');
  // Normalized coordinates are valid only for an unpadded full-window image.
  if(Math.abs(s.width-s.height*s.window.frame.width/s.window.frame.height)>2)throw new Error('Capture aspect ratio does not match the target window; no drag sent.');
  const x=action.box.x+action.box.width/2,y=action.box.y+action.box.height/2;
  if([x,y,action.to.x,action.to.y].some(n=>!Number.isFinite(n)||n<.01||n>.99))throw new Error('Drag points must remain inside the observed window.');
  return {action:'drag',inputMode:'background',...backgroundEventOptions,showAgentPointer:showPointer,dragDurationMs:duration,windowId:s.window.windowId,expectedFrame:s.window.frame,x,y,toX:action.to.x,toY:action.to.y};
}
export async function executeBridgeDrag(action:Candidate,s:Snapshot,duration:number,showPointer:boolean,signal?:AbortSignal,call=native){
  assertCanExecute(duration);
  signal?.throwIfAborted();
  const doctor=await call({action:'doctor'},signal);
  if(!doctor.accessibility||!doctor.screenRecording||!doctor.capabilities?.windowRoutedInput)throw new Error('Nyatinorma drag bridge lacks existing permissions or window-routed input. No input sent.');
  const actual=await call({action:'window',windowId:s.window.windowId},signal);
  const args=bridgeDragArgs(action,s,actual.window,duration,showPointer);
  signal?.throwIfAborted();
  // Once down/up has been dispatched, allow the bounded gesture to release.
  assertCanExecute(duration);
  const result=await call(args);
  signal?.throwIfAborted();return {driver:'macos-bridge',inputMode:'background',...result,verification:'Verify the post-drag Cua image; dispatch alone is not success.'};
}
