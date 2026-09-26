// SPDX-License-Identifier: MIT OR Apache-2.0
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import sharp from 'sharp';
import {config,dataDir,saveJSON} from './config.js';
import {CuaTransport,CuaTimeoutError} from './cua-transport.js';
import type {Snapshot,Candidate,WindowInfo} from './types.js';
import {assertCanExecute} from './execution-state.js';
import {native as macNative,capture as macCapture,execute as macExecute} from './macos.js';
import {executeBridgeDrag} from './drag.js';
export {backgroundEventOptions} from './macos.js';

// Load our adapters with the extension, not on the first click/drag. Otherwise
// a live source update can combine a new adapter with pi's cached old runtime.

let client:CuaTransport|undefined;
export function driverCapabilities(driver:'cua'|'macos-legacy',platform:NodeJS.Platform=process.platform,dragDriver:'cua'|'macos-bridge'='cua'){
  const separate=platform==='darwin'&&driver==='cua'&&dragDriver==='macos-bridge';
  return {driver,platform,deliveryMode:'background',dragDriver:separate?'macos-bridge':driver,backgroundDrag:separate?'configured':driver==='cua'&&platform==='darwin'?'unsupported':'unverified',guidance:separate?'Use ny_drag for a grounded drag. Capture/click use Cua; drag uses the separately configured Nyatinorma bridge in background mode. Verify card movement in the returned image. Never infer success from dispatch.':driver==='cua'&&platform==='darwin'?'macOS cua-driver refuses background drag. Use observed navigation buttons or report a blocker. Never retry as foreground or switch drivers automatically.':'Verify every input with a fresh screenshot; platform support does not prove game compatibility.'};
}
async function cua(){const c=await config();return client??=new CuaTransport(c.cuaDriverPath,['mcp'],c.desktopTimeoutSeconds*1000);}
export async function closeDesktop(){await client?.close();client=undefined;}
function rows(value:any,key:string):any[]{if(Array.isArray(value))return value;if(Array.isArray(value[key]))return value[key];throw new Error(`Unexpected cua-driver ${key} response`);}
export async function targetWindows(){const c=await config();return rows(await (await cua()).call('list_windows',c.targetPid?{pid:c.targetPid}:{}),'windows');}
export function chooseWindow(windows:any[],target:{targetPid?:number;targetWindowId?:number;targetApp:string}):WindowInfo {
  const matches=windows.filter(w=>w.is_on_screen!==false&&(!target.targetPid||w.pid===target.targetPid)&&(!target.targetWindowId||w.window_id===target.targetWindowId)&&(target.targetWindowId||(w.bounds??w.frame)?.height>40)&&((target.targetPid||target.targetWindowId)||w.app_name===target.targetApp||w.title===target.targetApp));
  if(matches.length!==1)throw new Error(matches.length?'대상 창이 여러 개입니다. nyatinorma.json의 targetPid/targetWindowId로 지정하세요.':'설정된 게임 창을 찾지 못했습니다. 앱을 열고 targetApp 또는 targetPid/targetWindowId를 확인하세요.');
  const w=matches[0];if(w.is_on_screen===false)throw new Error('게임 창이 최소화되었거나 캡처 불가능한 상태입니다.');
  const b=w.bounds??w.frame;
  if(!Number.isInteger(w.pid)||!Number.isInteger(w.window_id)||!b||![b.x,b.y,b.width,b.height].every(Number.isFinite))throw new Error('Unsupported cua-driver window metadata');
  return {windowId:w.window_id,pid:w.pid,title:w.title??w.app_name,frame:b};
}
async function window(){return chooseWindow(await targetWindows(),await config());}
async function diagnostics(){
  const client=await cua();
  const cursor=await client.call('get_cursor_position');
  // Older Windows/Linux catalogs may omit macOS list_apps diagnostics.
  let frontmostPid:number|undefined;
  if(process.platform==='darwin')frontmostPid=rows(await client.call('list_apps'),'apps').find(v=>v.active)?.pid;
  return {cursor,frontmostPid};
}
export async function native(params:Record<string,unknown>,signal?:AbortSignal):Promise<any>{
  const c=await config();if(c.driver==='macos-legacy')return macNative(params,signal);
  if(params.action==='doctor')return {driver:'cua',capabilities:driverCapabilities(c.driver,process.platform,c.dragDriver),permissions:await (await cua()).call('check_permissions'),target:await window(),sharedDriverUnmodified:true};
  throw new Error('공유 cua-driver의 권한·종료·재시작·전역 설정은 nyatinorma에서 변경하지 않습니다.');
}
export async function capture(signal?:AbortSignal):Promise<Snapshot>{
  try{return await captureOnce(signal);}catch(error){
    if(!(error instanceof CuaTimeoutError)||!['get_window_state','list_windows'].includes(error.operation)||signal?.aborted)throw error;
    // Read-only retry gets its own output file; a late old response cannot overwrite it.
    return captureOnce(signal);
  }
}
async function captureOnce(signal?:AbortSignal):Promise<Snapshot>{
  const c=await config();if(c.driver==='macos-legacy')return macCapture(signal);
  signal?.throwIfAborted();const w=await window(),id=`${Date.now()}-${randomUUID().slice(0,8)}`,path=resolve(dataDir,'captures',id+'.png');
  await (await cua()).call('get_window_state',{pid:w.pid,window_id:w.windowId,include_screenshot:true,screenshot_out_file:path,max_elements:1,max_depth:1},true,signal);
  signal?.throwIfAborted();
  // Keep driver screenshot pixels unchanged. Cua owns DPI/Retina conversion.
  // AX metadata is deliberately discarded; the planner receives images, no OCR.
  const meta=await sharp(path).metadata();if(!meta.width||!meta.height)throw new Error('Cua returned no readable window image.');
  const s:Snapshot={id,at:Date.now(),path,width:meta.width,height:meta.height,window:w,ocr:[]};
  await saveJSON(resolve(dataDir,'captures',id+'.json'),s);await writeFile(resolve(dataDir,'latest.txt'),id);return s;
}
export function actionArgs(action:Candidate,s:Snapshot,duration:number){
  if(!action.box)throw new Error('No observed target');
  const x=(action.box.x+action.box.width/2)*s.width,y=(action.box.y+action.box.height/2)*s.height;
  const common={pid:s.window.pid,window_id:s.window.windowId,delivery_mode:'background',scope:'window'};
  if(action.kind==='click')return {...common,x,y};
  if(action.kind!=='drag'||!action.to)throw new Error('Invalid drag endpoint');
  return {...common,from_x:x,from_y:y,to_x:action.to.x*s.width,to_y:action.to.y*s.height,duration_ms:duration};
}
export async function execute(action:Candidate,s:Snapshot,signal?:AbortSignal):Promise<any>{
  assertCanExecute();
  const c=await config();if(c.driver==='macos-legacy')return macExecute(action,s,signal);
  if(action.kind==='think')return;if(action.kind==='wait'){await new Promise(r=>setTimeout(r,1200));return;}
  if(action.kind==='drag'&&driverCapabilities(c.driver,process.platform,c.dragDriver).backgroundDrag==='unsupported')throw new Error('현재 macOS cua-driver는 백그라운드 드래그를 지원하지 않습니다. 별도 dragDriver 설정이 필요합니다. foreground 전환이나 드라이버 자동 교체는 하지 않습니다.');
  signal?.throwIfAborted();const fresh=await window();
  if(fresh.pid!==s.window.pid||fresh.windowId!==s.window.windowId||JSON.stringify(fresh.frame)!==JSON.stringify(s.window.frame))throw new Error('Target window changed; reobserve before input.');
  if(action.kind==='drag'&&process.platform==='darwin'&&c.dragDriver==='macos-bridge')return executeBridgeDrag(action,s,c.dragDurationMs,c.showAgentPointer,signal);
  const before=await diagnostics();
  assertCanExecute(action.kind==='drag'?c.dragDurationMs:0);
  const result=await (await cua()).call(action.kind,{...actionArgs(action,s,c.dragDurationMs),...(process.platform==='darwin'&&c.cuaModifiers.length?{modifier:c.cuaModifiers}:{})},true,signal);
  const after=await diagnostics();
  const cursorDistance=[before.cursor.x,before.cursor.y,after.cursor.x,after.cursor.y].every(Number.isFinite)?Math.hypot(after.cursor.x-before.cursor.x,after.cursor.y-before.cursor.y):undefined;
  const focusPreserved=before.frontmostPid!==undefined&&after.frontmostPid!==undefined?before.frontmostPid===after.frontmostPid:undefined;
  signal?.throwIfAborted();return {driver:'cua',inputMode:'background',result,before,after,cursorDistance,focusPreserved,verification:'Inspect the returned screenshot; driver dispatch alone is not success.'};
}
