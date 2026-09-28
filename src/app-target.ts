// SPDX-License-Identifier: MIT OR Apache-2.0
import {createHash} from 'node:crypto';
import type {WindowInfo} from './types.js';

export type AppWindow=WindowInfo & {appName:string;bundleId?:string};
export type AppTarget=AppWindow & {knowledgeAppId:string};
type TargetConfig={targetApp:string;bundleId:string;knowledgeAppId?:string};
let selected:AppTarget|null=null;
let required=false;
let revision=0;
export function currentTarget(){return selected;}
export function targetRevision(){return revision;}
export function requireTargetSelection(value=true){required=value;}
export function setTarget(target:AppTarget|null){
  if(JSON.stringify(selected)!==JSON.stringify(target))revision++;
  selected=target;
}
export function assertTargetSelected(){if(required&&!selected)throw new Error('target_not_selected: ny_target list로 창을 나열한 뒤 사용자 요청에 맞는 창을 select하세요.');}
export function sameApp(a:AppWindow,b:AppWindow){return a.bundleId&&b.bundleId?a.bundleId===b.bundleId:Boolean(a.appName&&a.appName===b.appName);}
export function configuredKnowledgeId(c:TargetConfig){
  const name=c.bundleId||c.targetApp;
  return c.knowledgeAppId??(name.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,63)||'workspace');
}
export function bindAppWindow(window:AppWindow,c:TargetConfig):AppTarget{
  const configured=c.bundleId&&window.bundleId?window.bundleId===c.bundleId:Boolean(c.targetApp&&window.appName===c.targetApp);
  const identity=window.bundleId||window.appName;
  // Hash preserves non-Latin names and avoids collisions between slugged names.
  const slug=identity.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,45)||'app';
  return {...window,...(configured&&!window.bundleId&&c.bundleId?{bundleId:c.bundleId}:{}),knowledgeAppId:configured?configuredKnowledgeId(c):`${slug}-${createHash('sha256').update(identity).digest('hex').slice(0,12)}`};
}
export function appWindows(rows:any[]):AppWindow[]{
  return rows.flatMap(w=>{
    const frame=w.bounds??w.frame,appName=w.app_name??w.appName;
    if(w.is_on_screen===false||!Number.isInteger(w.pid)||w.pid<=0||!Number.isInteger(w.window_id)||typeof appName!=='string'||!appName||!frame||![frame.x,frame.y,frame.width,frame.height].every(Number.isFinite)||frame.width<=0||frame.height<=40)return [];
    const bundleId=w.bundle_id??w.bundle_identifier??w.bundleId;
    return [{pid:w.pid,windowId:w.window_id,appName,title:typeof w.title==='string'?w.title:appName,frame,...(typeof bundleId==='string'&&bundleId?{bundleId}:{})}];
  });
}
export function resolveAppWindow(windows:AppWindow[],target:AppTarget):AppTarget{
  const matches=windows.filter(w=>sameApp(w,target));
  const exact=matches.find(w=>w.pid===target.pid&&w.windowId===target.windowId);
  const candidate=exact??(matches.length===1?matches[0]:undefined);
  if(!candidate)throw new Error(matches.length?'target_ambiguous: 같은 앱의 창이 여러 개입니다. ny_target list/select로 다시 선택하세요.':'target_missing: 대상 앱 창을 찾지 못했습니다. ny_target list로 확인하세요.');
  return {...target,...candidate};
}
export function targetFromBranch(entries:readonly {type:string;customType?:string;data?:unknown}[]):AppTarget|null{
  const data=entries.findLast(e=>e.type==='custom'&&e.customType==='nyatinorma-target')?.data as AppTarget|undefined;
  if(!data||!Number.isInteger(data.pid)||!Number.isInteger(data.windowId)||typeof data.appName!=='string'||!data.appName||!data.frame||![data.frame.x,data.frame.y,data.frame.width,data.frame.height].every(Number.isFinite)||!data.knowledgeAppId||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(data.knowledgeAppId))return null;
  return data;
}
