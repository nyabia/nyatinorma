// SPDX-License-Identifier: MIT OR Apache-2.0
import {mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import sharp from 'sharp';
import {saveJSON} from './config.js';
import {appKnowledgeId} from './app-target.js';
import {executionHost,executionSnapshot} from './host-context.js';
import {reservedExecutionIds} from './execution-contract.js';
import {activeRunPath} from './runs.js';
import {pointBox} from './vision.js';
import type {Point,Box,Snapshot} from './types.js';

// 화면 종류와 컨트롤의 위치·역할·직접 효과만 저장하며 현재 목표의 판단 조건은 저장하지 않는다.
export type ActPointInput={snapshotId:string;id:string;label:string;screen:string;description:string;point?:Point;box?:Box;jitter?:number};
export type RegisteredActPoint={
  id:string;label:string;screen:string;description:string;snapshotId:string;
  knowledgeAppId?:string;appIdentity:string;
  reference:{width:number;height:number};
  // 전체 캡처 중심을 원점으로 한 비율이다. 호출자는 기존 좌상단 기준 좌표만 전달한다.
  center:Point;size?:{width:number;height:number};jitter:number;
  createdAt:number;updatedAt:number;
};
export type ProjectedActPoint={entry:RegisteredActPoint;point:Point;box:Box};
type Registry={schemaVersion:2;entries:RegisteredActPoint[]};
const mutations=new Map<string,Promise<void>>();
const reserved:Record<string,true>={replan:true,uncertain:true,none:true,think:true,yes:true,no:true,['__proto__']:true,constructor:true as const,prototype:true};
// 중심 좌표 왕복 연산의 부동소수점 오차만 허용한다. 좌표 자체는 보정하지 않는다.
const geometryEpsilon=Number.EPSILON*8;
function checkedId(value:string){
  if(typeof value!=='string')throw new Error('등록 ID는 문자열이어야 합니다.');
  if(!/^[a-z][a-z0-9_-]{0,31}$/.test(value))throw new Error('등록 ID는 영문 소문자로 시작하는 1–32자의 소문자·숫자·-·_여야 합니다.');
  if(reservedExecutionIds.has(value)||Object.hasOwn(reserved,value)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value))throw new Error('예약된 등록 ID는 사용할 수 없습니다.');
  return value;
}
function checkedText(value:string,name:string,max:number){
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw new Error(`${name}: 비어 있지 않은 ${max}자 이하 문자열이 필요합니다.`);
  return value.trim();
}
function dimensions(width:number,height:number){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0)throw new Error('캡처 크기는 양의 정수여야 합니다.');
}
function checkedPoint(point:Point){
  if(!point||![point.x,point.y].every(n=>Number.isFinite(n)&&n>0&&n<1))throw new Error('점은 전체 캡처의 0과 1 사이 내부 좌표여야 합니다.');
}
function checkedBox(box:Box,epsilon=0){
  if(!box||![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.x< -epsilon||box.y< -epsilon||box.width<=0||box.height<=0||box.x+box.width>1+epsilon||box.y+box.height>1+epsilon)throw new Error('상자는 전체 캡처의 0–1 범위 안에 있어야 합니다.');
}
function checkedJitter(jitter:number,box:boolean){
  if(!Number.isFinite(jitter)||jitter<0||jitter>.45||(!box&&jitter!==0))throw new Error('상자 jitter는 0–0.45, 점 jitter는 0이어야 합니다.');
}
function appIdentity(snapshot:Snapshot){
  if(snapshot.window.bundleId||snapshot.window.appName)return appKnowledgeId({...snapshot.window,appName:snapshot.window.appName??snapshot.window.bundleId!});
  if(!Number.isSafeInteger(snapshot.window.pid)||snapshot.window.pid<=0)throw new Error('캡처 앱 식별자가 없습니다.');
  return `pid:${snapshot.window.pid}`;
}
function sameApp(entry:RegisteredActPoint,snapshot:Snapshot){
  // 양쪽에 지식 앱 ID가 있으면 그것만 비교한다. 없는 이전 캡처만 앱 식별자로 비교한다.
  return entry.knowledgeAppId&&snapshot.knowledgeAppId?entry.knowledgeAppId===snapshot.knowledgeAppId:entry.appIdentity===appIdentity(snapshot);
}
function registryPath(){
  const host=executionHost();
  if(host){
    if(typeof host.actPointDirectory!=='string'||!host.actPointDirectory.trim())throw new Error('호스트가 실행별 actPointDirectory를 제공해야 합니다.');
    return resolve(host.actPointDirectory,'act-points.json');
  }
  return resolve(activeRunPath(),'act-points','act-points.json');
}
function record(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function validEntry(value:unknown):value is RegisteredActPoint{
  if(!record(value)||'when' in value||'expectation' in value||!record(value.reference)||!record(value.center)||(value.size!==undefined&&!record(value.size)))return false;
  try{
    if(typeof value.id!=='string'||typeof value.label!=='string'||typeof value.screen!=='string'||typeof value.description!=='string'||typeof value.snapshotId!=='string'||typeof value.appIdentity!=='string')return false;
    checkedId(value.id);checkedText(value.label,'label',160);checkedText(value.screen,'screen',2000);checkedText(value.description,'description',2000);checkedText(value.snapshotId,'snapshotId',256);checkedText(value.appIdentity,'appIdentity',512);
    if(value.knowledgeAppId!==undefined&&(typeof value.knowledgeAppId!=='string'||!value.knowledgeAppId.trim()))return false;
    if(typeof value.reference.width!=='number'||typeof value.reference.height!=='number'||typeof value.center.x!=='number'||typeof value.center.y!=='number'||typeof value.jitter!=='number'||typeof value.createdAt!=='number'||typeof value.updatedAt!=='number')return false;
    dimensions(value.reference.width,value.reference.height);
    if(![value.createdAt,value.updatedAt].every(n=>Number.isFinite(n)&&n>=0))return false;
    const point={x:.5+value.center.x,y:.5+value.center.y};checkedPoint(point);
    checkedJitter(value.jitter,value.size!==undefined);
    if(value.size){
      if(typeof value.size.width!=='number'||typeof value.size.height!=='number')return false;
      checkedBox({x:point.x-value.size.width/2,y:point.y-value.size.height/2,width:value.size.width,height:value.size.height},geometryEpsilon);
    }
    return true;
  }catch{return false;}
}
async function readRegistry(path:string):Promise<Registry>{
  let value:unknown;
  try{value=JSON.parse(await readFile(path,'utf8'));}
  catch(error:unknown){if(record(error)&&error.code==='ENOENT')return {schemaVersion:2,entries:[]};throw error;}
  if(!record(value))throw new Error('등록 좌표 저장소가 손상되었습니다.');
  if(value.schemaVersion===1)throw new Error('등록 좌표 저장소 v1은 메타데이터 업그레이드가 필요합니다. 각 항목의 when·expectation을 화면 종류 screen과 컨트롤 설명 description으로 명시적으로 마이그레이션하고 schemaVersion을 2로 변경하세요.');
  if(value.schemaVersion!==2)throw new Error('지원하지 않는 등록 좌표 저장소 스키마입니다. screen·description 메타데이터를 갖춘 schemaVersion 2로 명시적 마이그레이션이 필요합니다.');
  if(!Array.isArray(value.entries)||!value.entries.every(validEntry)||new Set(value.entries.map(entry=>entry.id)).size!==value.entries.length)throw new Error('등록 좌표 저장소가 손상되었습니다.');
  return {schemaVersion:2,entries:value.entries};
}
function mutate<T>(path:string,change:(registry:Registry)=>T):Promise<T>{
  const prior=mutations.get(path)??Promise.resolve();
  const operation=prior.then(async()=>{
    const registry=await readRegistry(path),result=change(registry);
    await mkdir(resolve(path,'..'),{recursive:true});await saveJSON(path,registry);return result;
  });
  const pending=operation.then(()=>{},()=>{});mutations.set(path,pending);
  void pending.then(()=>{if(mutations.get(path)===pending)mutations.delete(path);});
  return operation;
}

/** 저장된 캡처만 읽으며 관측·포커스 변경·입력을 발생시키지 않는다. */
export async function addActPoint(input:ActPointInput):Promise<RegisteredActPoint>{
  if('when' in input||'expectation' in input)throw new Error('등록 좌표는 when·expectation을 허용하지 않습니다. screen과 description을 사용하세요.');
  const path=registryPath(),id=checkedId(input.id),snapshotId=checkedText(input.snapshotId,'snapshotId',256);
  const label=checkedText(input.label,'label',160),screen=checkedText(input.screen,'screen',2000),description=checkedText(input.description,'description',2000);
  if((input.point!==undefined)===(input.box!==undefined))throw new Error('point 또는 box 중 정확히 하나를 전달하세요.');
  const size=input.box?{width:input.box.width,height:input.box.height}:undefined;
  if(input.box!==undefined)checkedBox(input.box);else checkedPoint(input.point!);
  const jitter=input.jitter===undefined?(size ? .15 : 0):input.jitter;checkedJitter(jitter,size!==undefined);
  const point=input.box?{x:input.box.x+input.box.width/2,y:input.box.y+input.box.height/2}:{...input.point!};
  const center={x:point.x-.5,y:point.y-.5};
  const knownSnapshot=await executionSnapshot(snapshotId);
  if(!knownSnapshot||knownSnapshot.id!==snapshotId)throw new Error('알려진 snapshotId의 저장된 캡처가 필요합니다.');
  dimensions(knownSnapshot.width,knownSnapshot.height);
  const identity=appIdentity(knownSnapshot),knowledgeAppId=knownSnapshot.knowledgeAppId;
  if(knowledgeAppId!==undefined)checkedText(knowledgeAppId,'knowledgeAppId',128);
  return mutate(path,registry=>{
    const previous=registry.entries.find(entry=>entry.id===id),now=Date.now();
    const entry:RegisteredActPoint={id,label,screen,description,snapshotId,appIdentity:identity,...(knowledgeAppId?{knowledgeAppId}:{}),reference:{width:knownSnapshot.width,height:knownSnapshot.height},center,...(size?{size}:{}),jitter,createdAt:previous?.createdAt??now,updatedAt:now};
    if(!validEntry(entry))throw new Error('등록 좌표를 중심 상대 좌표로 안전하게 표현할 수 없습니다.');
    registry.entries=registry.entries.filter(value=>value.id!==id);registry.entries.push(entry);registry.entries.sort((a,b)=>a.id.localeCompare(b.id));return entry;
  });
}
export async function removeActPoint(id:string):Promise<{id:string;removed:boolean}>{
  checkedId(id);return mutate(registryPath(),registry=>{
    const count=registry.entries.length;registry.entries=registry.entries.filter(entry=>entry.id!==id);return {id,removed:registry.entries.length!==count};
  });
}
export async function listActPoints(snapshot?:Snapshot):Promise<RegisteredActPoint[]>{
  const path=registryPath();await mutations.get(path);
  const entries=(await readRegistry(path)).entries;
  return snapshot?entries.filter(entry=>sameApp(entry,snapshot)):entries;
}

/** 중앙 레터박스와 균일 배율을 가정한다. 검은 띠 감지나 목표 안쪽으로의 보정은 하지 않는다. */
export function projectActPoint(entry:RegisteredActPoint,snapshot:Snapshot,random:()=>number=Math.random):ProjectedActPoint|undefined{
  if(!validEntry(entry))return undefined;
  try{
    dimensions(snapshot.width,snapshot.height);if(!sameApp(entry,snapshot))return undefined;
    const scale=Math.min(snapshot.width/entry.reference.width,snapshot.height/entry.reference.height);
    const sx=entry.reference.width*scale/snapshot.width,sy=entry.reference.height*scale/snapshot.height;
    const center={x:.5+entry.center.x*sx,y:.5+entry.center.y*sy};checkedPoint(center);
    const box=entry.size?{x:center.x-entry.size.width*sx/2,y:center.y-entry.size.height*sy/2,width:entry.size.width*sx,height:entry.size.height*sy}:pointBox(center,snapshot.width,snapshot.height);
    checkedBox(box,geometryEpsilon);
    const triangular=()=>{
      const a=random(),b=random();if(![a,b].every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw new Error('난수는 0–1 범위여야 합니다.');return a-b;
    };
    const point=entry.size&&entry.jitter?{x:center.x+triangular()*box.width*entry.jitter,y:center.y+triangular()*box.height*entry.jitter}:center;
    checkedPoint(point);
    if(point.x<box.x||point.x>box.x+box.width||point.y<box.y||point.y>box.y+box.height)return undefined;
    return {entry,point,box};
  }catch{return undefined;}
}
function escapeXML(value:string){return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]??char));}
type LabelAnchor={id:string;x:number;y:number;width:number};
function placePointLabels(anchors:LabelAnchor[],width:number,height:number,labelHeight:number):Box[]{
  const margin=4,gap=3,placed:Box[]=new Array(anchors.length);
  const markers=anchors.map(({x,y})=>({x:x-9,y:y-9,width:18,height:18}));
  // 긴 ID부터 배치하되 동률은 ID로 정렬하여 입력 배열 순서에 따라 흔들리지 않게 한다.
  const order=anchors.map((_,index)=>index).sort((a,b)=>anchors[b].width-anchors[a].width||anchors[a].id.localeCompare(anchors[b].id));
  const occupied:Box[]=[];
  for(const index of order){
    const anchor=anchors[index],maxX=width-margin-anchor.width,maxY=height-margin-labelHeight;
    if(maxX<margin||maxY<margin)throw new Error('등록점 라벨을 표시할 공간이 부족합니다. 창을 넓히거나 등록을 줄이세요.');
    const xs=new Set<number>(),ys=new Set<number>();
    const addX=(x:number)=>xs.add(Math.max(margin,Math.min(maxX,x)));
    const addY=(y:number)=>ys.add(Math.max(margin,Math.min(maxY,y)));
    addX(anchor.x+12);addX(anchor.x-anchor.width-12);addX(margin);addX(maxX);
    addY(anchor.y-labelHeight-12);addY(anchor.y+12);addY(margin);addY(maxY);
    const obstacles=[...markers,...occupied];
    for(const obstacle of obstacles){
      addX(obstacle.x-anchor.width-gap);addX(obstacle.x+obstacle.width+gap);
      addY(obstacle.y-labelHeight-gap);addY(obstacle.y+obstacle.height+gap);
    }
    let best:Box|undefined,bestDistance=Infinity;
    for(const x of xs)for(const y of ys){
      const dx=Math.max(x-anchor.x,0,anchor.x-x-anchor.width),dy=Math.max(y-anchor.y,0,anchor.y-y-labelHeight),distance=dx*dx+dy*dy;
      if(distance>=bestDistance)continue;
      if(obstacles.some(other=>x<other.x+other.width+gap&&x+anchor.width+gap>other.x&&y<other.y+other.height+gap&&y+labelHeight+gap>other.y))continue;
      best={x,y,width:anchor.width,height:labelHeight};bestDistance=distance;
    }
    // 서로 겹친 라벨을 증거로 보내거나 등록 일부를 조용히 숨기지 않는다.
    if(!best)throw new Error('등록점 라벨을 겹치지 않게 배치할 수 없습니다. 창을 넓히거나 등록을 줄이세요.');
    placed[index]=best;occupied.push(best);
  }
  return placed;
}
/** SELECT에 제공할 표식은 이 캡처에서 실제로 표본 추출한 점과 정확히 일치한다. */
export async function renderActPointOverlay(snapshot:Snapshot,points:ProjectedActPoint[]):Promise<string>{
  dimensions(snapshot.width,snapshot.height);
  const image=sharp(snapshot.path),metadata=await image.metadata();
  if(metadata.width!==snapshot.width||metadata.height!==snapshot.height)throw new Error('저장된 캡처와 이미지 크기가 다릅니다.');
  const bytes=await image.resize({width:1200,withoutEnlargement:true}).png().toBuffer();
  const resized=await sharp(bytes).metadata(),width=resized.width!,height=resized.height!,font=Math.max(12,Math.min(20,width/50));
  const anchors=points.map(({entry,point,box})=>{
    if(!validEntry(entry)||!sameApp(entry,snapshot))throw new Error('다른 앱의 등록은 표시할 수 없습니다.');
    checkedPoint(point);checkedBox(box,geometryEpsilon);
    if(point.x<box.x||point.x>box.x+box.width||point.y<box.y||point.y>box.y+box.height)throw new Error('클릭 표식이 등록 상자를 벗어났습니다.');
    return {id:entry.id,x:point.x*width,y:point.y*height,width:Math.min(width-8,entry.id.length*font*.65+8)};
  });
  const labels=placePointLabels(anchors,width,height,font+6);
  const boxes=points.map(({box})=>`<rect x="${box.x*width}" y="${box.y*height}" width="${box.width*width}" height="${box.height*height}" fill="none" stroke="#ff4080" stroke-width="2"/>`).join('');
  const leaders=anchors.map(({x,y},index)=>{
    const label=labels[index],endX=Math.max(label.x,Math.min(label.x+label.width,x)),endY=Math.max(label.y,Math.min(label.y+label.height,y));
    return `<path d="M ${x} ${y} L ${endX} ${endY}" fill="none" stroke="#ff4080" stroke-width="1"/>`;
  }).join('');
  const marks=anchors.map(({x,y})=>`<g stroke="#ff4080" stroke-width="2" fill="none"><circle cx="${x}" cy="${y}" r="5"/><path d="M ${x-8} ${y} H ${x+8} M ${x} ${y-8} V ${y+8}"/></g>`).join('');
  const text=anchors.map(({id},index)=>{
    const label=labels[index];
    return `<rect x="${label.x}" y="${label.y}" width="${label.width}" height="${label.height}" fill="#fff" fill-opacity=".9"/><text x="${label.x+4}" y="${label.y+font+2}" fill="#000" font-family="monospace" font-size="${font}" textLength="${Math.max(1,label.width-8)}" lengthAdjust="spacingAndGlyphs">${escapeXML(id)}</text>`;
  }).join('');
  return (await sharp(bytes).composite([{input:Buffer.from(`<svg width="${width}" height="${height}">${boxes}${leaders}${marks}${text}</svg>`)}]).png().toBuffer()).toString('base64');
}
