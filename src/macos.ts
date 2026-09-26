// SPDX-License-Identifier: MIT OR Apache-2.0
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {writeFile,readFile,mkdir,rename,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {config,dataDir,root,saveJSON} from './config.js';
import type {Snapshot,Candidate} from './types.js';
import {normalizeCapture} from './vision.js';
import {assertCanExecute} from './execution-state.js';
const exec = promisify(execFile);
// Native iPad app background input: NSEvent factory, per-window location,
// and Command modifier preserve the user's foreground app and desktop cursor.
export const backgroundEventOptions={backgroundTransport:'public',eventFactory:'appkit',commandClick:true} as const;
let started=false;
export async function native(params:Record<string,unknown>,signal?:AbortSignal):Promise<any> {
  const c=await config();
  const dir=resolve(dataDir,'ipc');await mkdir(dir,{recursive:true,mode:0o700});
  if(!started){await exec('/usr/bin/open',['-g',resolve(root,'Nyatinorma Bridge.app')]);started=true;}
  const id=`${Date.now()}-${randomUUID()}`;const request=resolve(dir,id+'.request.json'),response=resolve(dir,id+'.response.json');
  const deadline=Date.now()+c.desktopTimeoutSeconds*1000;
  await writeFile(request+'.tmp',JSON.stringify({bundleId:c.bundleId,...params,expiresAt:deadline}),{mode:0o600});await rename(request+'.tmp',request);
  try {
    while(Date.now()<deadline){
      signal?.throwIfAborted();
      try {const result=JSON.parse(await readFile(response,'utf8'));await unlink(response);if(!result.ok)throw new Error(result.error);if(params.action==='shutdown')started=false;return result;}
      catch(e:any){if(e.code!=='ENOENT')throw e;}
      await new Promise(r=>setTimeout(r,60));
    }
    started=false;throw new Error('Native bridge timed out. Input outcome may be unknown; observe before retrying.');
  }finally{await unlink(request).catch(()=>{});}
}
export async function capture(signal?:AbortSignal):Promise<Snapshot> {
  const id = `${Date.now()}-${randomUUID().slice(0,8)}`;
  const result=await native({action:'capture',path:resolve(dataDir,'captures',id+'.png')},signal);
  if(result.recognition!=='vision-only')throw new Error('OCR-free capture requires Nyatinorma Bridge protocol 4. Rebuild and restart the bridge.');
  const normalized=await normalizeCapture(result.path,result.window.frame);
  const s:Snapshot={id,at:Date.now(),path:result.path,window:result.window,ocr:[],...normalized};
  await saveJSON(resolve(dataDir,'captures',id+'.json'),s);
  await writeFile(resolve(dataDir,'latest.txt'),id); return s;
}
export async function execute(candidate:Candidate,s:Snapshot,signal?:AbortSignal) {
  assertCanExecute();
  if(candidate.kind==='think') return;
  if(candidate.kind==='wait') { await new Promise<void>((resolve,reject)=>{ const timer=setTimeout(resolve,1200); signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true}); }); return; }
  if(!candidate.box) throw new Error('No observed target box');
  const c=await config();
  if(c.inputMode!=='background'&&c.inputMode!=='foreground')throw new Error('Unknown inputMode; no input sent.');
  const bridge=await native({action:'doctor'},signal);
  if(c.inputMode==='background'&&!bridge.capabilities?.windowRoutedInput)throw new Error('Background input requires the window-routing Nyatinorma Bridge (protocol 3). Rebuild/restart the bridge; foreground fallback is disabled.');
  const p={action:candidate.kind,inputMode:c.inputMode,...(c.inputMode==='background'?backgroundEventOptions:{}),showAgentPointer:c.showAgentPointer,dragDurationMs:c.dragDurationMs,windowId:s.window.windowId,expectedFrame:s.window.frame,
    x:candidate.box.x+candidate.box.width/2,y:candidate.box.y+candidate.box.height/2,
    ...(candidate.to?{toX:candidate.to.x,toY:candidate.to.y}:{})};
  // Do not kill a native input process between mouse-down and mouse-up. It is bounded;
  // cancellation is checked before dispatch and immediately after the release.
  signal?.throwIfAborted();assertCanExecute(candidate.kind==='drag'?c.dragDurationMs:0); const result=await native(p); signal?.throwIfAborted();return result;
}
