// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type {OutputInfo} from 'sharp';
import {addActPoint,removeActPoint,listActPoints,projectActPoint,renderActPointOverlay} from '../src/act-points.js';
import type {ActPointInput,ProjectedActPoint} from '../src/act-points.js';
import type * as ActPointRegistry from '../src/act-points.js';
import {dataDir,defaults,saveJSON} from '../src/config.js';
import {withExecutionHost} from '../src/host-context.js';
import type {ExecutionHost} from '../src/host-context.js';
import {bindRun} from '../src/runtime.js';
import type {Run} from '../src/runtime.js';
import {runPath} from '../src/runs.js';
import type {Point,Box,Snapshot} from '../src/types.js';

const input:ActPointInput={snapshotId:'source',id:'open-menu',label:'메뉴 열기',screen:'메인 화면',description:'오른쪽 위 메뉴 버튼. 누르면 메뉴 패널이 열린다.',point:{x:.75,y:.25}};
const close=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-12,`${actual} != ${expected}`);
function closePoint(actual:Point,expected:Point){close(actual.x,expected.x);close(actual.y,expected.y);}
function closeBox(actual:Box,expected:Box){closePoint(actual,expected);close(actual.width,expected.width);close(actual.height,expected.height);}
function sample(values:number[]){let i=0;return ()=>values[i++%values.length];}
async function fixture(body:(context:{directory:string;source:Snapshot;host:(directory?:string)=>ExecutionHost;screens:Map<string,Snapshot>})=>Promise<void>){
  await mkdir(join(dataDir,'test-tmp'),{recursive:true});
  const directory=await mkdtemp(join(dataDir,'test-tmp','ny-act-points-'));
  try{
    const path=join(directory,'source.png');
    await sharp({create:{width:400,height:300,channels:3,background:'#222'}}).png().toFile(path);
    const source:Snapshot={id:'source',path,at:1,width:400,height:300,ocr:[],knowledgeAppId:'test-app',window:{pid:10,windowId:20,title:'테스트 화면',appName:'Test App',bundleId:'example.test',frame:{x:100,y:-200,width:400,height:300}}};
    const screens=new Map([[source.id,source]]);
    const host=(storage?:string):ExecutionHost=>({id:randomUUID(),actPointDirectory:storage,config:async()=>({...defaults}),snapshot:async id=>screens.get(id),loadContinuation:async()=>undefined,saveContinuation:async()=>{}});
    await body({directory,source,host,screens});
  }finally{await rm(directory,{recursive:true,force:true});}
}

type OverlayRaster={data:Buffer;info:OutputInfo};
async function overlayRaster(source:Snapshot,points:ProjectedActPoint[]):Promise<OverlayRaster>{
  return sharp(Buffer.from(await renderActPointOverlay(source,points),'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});
}
function separatedWhiteLabels(raster:OverlayRaster,expected:number){
  const {data,info:{width,height,channels}}=raster,mask=new Uint8Array(width*height);
  for(let index=0;index<mask.length;index++){
    const offset=index*channels,r=data[offset],g=data[offset+1],b=data[offset+2];
    if(r>=200&&g>=200&&b>=200)mask[index]=1;
  }
  const rectangles:{x:number;y:number;right:number;bottom:number}[]=[];
  for(let start=0;start<mask.length;start++){
    if(mask[start]!==1)continue;
    const queue=[start];mask[start]=2;
    let left=width,top=height,right=0,bottom=0;
    for(let cursor=0;cursor<queue.length;cursor++){
      const index=queue[cursor],x=index%width,y=Math.floor(index/width);
      left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
      const visit=(next:number)=>{if(mask[next]===1){mask[next]=2;queue.push(next);}};
      if(x>0)visit(index-1);if(x+1<width)visit(index+1);if(y>0)visit(index-width);if(y+1<height)visit(index+width);
    }
    // 글자 속 흰 구멍은 제외하고 라벨 바탕의 연결 성분만 검사한다.
    if(right-left+1>=40&&bottom-top+1>=10)rectangles.push({x:left,y:top,right,bottom});
  }
  assert.equal(rectangles.length,expected,'각 등록점은 서로 연결되지 않은 흰 라벨 바탕을 가져야 한다');
  for(const [index,rect] of rectangles.entries()){
    assert.ok(rect.x>0&&rect.y>0&&rect.right<width-1&&rect.bottom<height-1,'라벨 전체가 이미지 안에 있어야 한다');
    for(const other of rectangles.slice(index+1))assert.ok(rect.right<other.x||other.right<rect.x||rect.bottom<other.y||other.bottom<rect.y,'라벨의 사각형 영역은 서로 겹치면 안 된다');
  }
  return rectangles;
}
function retainedClickMarkers(raster:OverlayRaster,points:Point[]){
  const {data,info:{width,height,channels}}=raster;
  for(const point of points){
    const x=Math.round(point.x*width),y=Math.round(point.y*height);
    // 중심뿐 아니라 십자선도 실제 클릭 좌표에 남아 있어야 한다.
    for(const [dx,dy] of [[0,0],[-6,0],[6,0],[0,-6],[0,6]]){
      const px=x+dx,py=y+dy;if(px<0||px>=width||py<0||py>=height)continue;
      const offset=(py*width+px)*channels;
      assert.deepEqual([...data.subarray(offset,offset+3)],[255,64,128],`클릭 표식 누락: ${px},${py}`);
    }
  }
}

test('중앙 레터박스는 원본 중심 상대 좌표와 상자 크기를 같은 균일 배율로 투영한다',async()=>fixture(async({directory,source,host})=>{
  await withExecutionHost(host(directory),async()=>{
    const point=await addActPoint(input);
    assert.deepEqual(point.reference,{width:400,height:300});assert.deepEqual(point.center,{x:.25,y:-.25});assert.equal(point.jitter,0);assert.equal(point.snapshotId,'source');
    const current={...source,id:'square',width:800,height:800,window:{...source.window,frame:{x:-900,y:500,width:800,height:800}}};
    closePoint(projectActPoint(point,current)!.point,{x:.75,y:.3125});
    const box=await addActPoint({...input,id:'panel',point:undefined,box:{x:.2,y:.1,width:.2,height:.2},jitter:0});
    const projected=projectActPoint(box,current)!;
    closeBox(projected.box,{x:.2,y:.2,width:.2,height:.15});closePoint(projected.point,{x:.3,y:.275});
  });
}));


test('상자 jitter는 재현 가능하며 지정 범위의 끝점과 중심을 투영한다',async()=>fixture(async({directory,source,host})=>{
  await withExecutionHost(host(directory),async()=>{
    const entry=await addActPoint({...input,point:undefined,box:{x:.2,y:.3,width:.4,height:.4},jitter:.45});
    const extreme=projectActPoint(entry,source,sample([0,1,1,0]))!;
    closePoint(extreme.point,{x:.22,y:.68});
    assert.deepEqual(extreme,projectActPoint(entry,source,sample([0,1,1,0])));
    closePoint(projectActPoint(entry,source,()=>.5)!.point,{x:.4,y:.5});
  });
}));


test('등록점은 추가·갱신·제거되고 재시작 후에도 저장값을 유지한다',async()=>fixture(async({directory,source,host})=>{
  await withExecutionHost(host(directory),async()=>{
    await addActPoint({...input,id:'button-0'});await addActPoint({...input,id:'button-1'});
    assert.equal((await listActPoints()).length,2);
    const first=(await listActPoints()).find(entry=>entry.id==='button-0')!;
    const updated=await addActPoint({...input,id:'button-0',label:'갱신된 메뉴',point:{x:.25,y:.75}});
    assert.equal(updated.createdAt,first.createdAt);assert.equal((await listActPoints()).length,2);
    assert.deepEqual(await removeActPoint('button-1'),{id:'button-1',removed:true});
    assert.deepEqual(await removeActPoint('button-1'),{id:'button-1',removed:false});
    const before=await listActPoints(source);
    // 정적 import는 기존 모듈 상태를 재사용하므로 별도 모듈 로딩 경계로 재시작을 재현한다.
    const restarted:typeof ActPointRegistry=await import(new URL(`../src/act-points.ts?restart=${randomUUID()}`,import.meta.url).href);
    assert.deepEqual(await restarted.listActPoints(source),before);
    closePoint(restarted.projectActPoint(before.find(entry=>entry.id==='button-0')!,source)!.point,{x:.25,y:.75});
  });
}));

test('호스트 저장소는 실행마다 격리되고 디렉터리 없는 호스트는 독립 실행으로 우회하지 않는다',async()=>fixture(async({directory,host})=>{
  const one=host(join(directory,'one')),two=host(join(directory,'two'));
  await withExecutionHost(one,()=>addActPoint(input));
  assert.deepEqual(await withExecutionHost(two,()=>listActPoints()),[]);
  await withExecutionHost(two,()=>addActPoint({...input,label:'다른 실행 메뉴'}));
  assert.equal((await withExecutionHost(one,()=>listActPoints()))[0].label,input.label);
  assert.equal((await withExecutionHost(two,()=>listActPoints()))[0].label,'다른 실행 메뉴');
  await withExecutionHost(host(),async()=>{
    await assert.rejects(addActPoint(input),/actPointDirectory/);await assert.rejects(listActPoints(),/actPointDirectory/);await assert.rejects(removeActPoint(input.id),/actPointDirectory/);
  });
}));

test('독립 실행의 등록은 현재 run 안에서만 유지되고 호스트 누락 설정으로 유출되지 않는다',async()=>fixture(async({directory,source,host})=>{
  const ids=[`run-points-${randomUUID()}`,`run-points-${randomUUID()}`],snapshotId=`${Date.now()}-${randomUUID().slice(0,8)}`;
  const capturePath=join(dataDir,'captures',snapshotId+'.json');
  const run=(id:string):Run=>({id,title:'등록 테스트',status:'ready',preset:{id:'scratch',name:'테스트',objective:'좌표 등록',instructions:[],successCriteria:[],revision:1,updatedAt:1},createdAt:1,updatedAt:1});
  await mkdir(join(dataDir,'captures'),{recursive:true});await saveJSON(capturePath,{...source,id:snapshotId});
  try{
    bindRun(run(ids[0]));await addActPoint({...input,snapshotId});
    bindRun(run(ids[1]));assert.deepEqual(await listActPoints(),[]);assert.deepEqual(await removeActPoint(input.id),{id:input.id,removed:false});
    bindRun(run(ids[0]));assert.equal((await listActPoints()).length,1);
    await withExecutionHost(host(),async()=>{await assert.rejects(listActPoints(),/actPointDirectory/);});
    assert.equal((await listActPoints()).length,1);
    await withExecutionHost(host(join(directory,'isolated')),async()=>assert.deepEqual(await listActPoints(),[]));
  }finally{bindRun(null);await rm(capturePath,{force:true});await Promise.all(ids.map(id=>rm(runPath(id),{recursive:true,force:true})));}
  await assert.rejects(listActPoints(),/기록/);
}));

test('등록점은 같은 앱의 새 창에 투영되고 다른 앱에는 노출되지 않는다',async()=>fixture(async({directory,source,host})=>{
  await withExecutionHost(host(directory),async()=>{
    const entry=await addActPoint(input);
    const wrong={...source,knowledgeAppId:'other-app'};
    assert.deepEqual(await listActPoints(wrong),[]);assert.equal(projectActPoint(entry,wrong),undefined);
    const newWindow={...source,window:{...source.window,pid:100,windowId:200,title:'새 화면'}};
    assert.equal((await listActPoints(newWindow)).length,1);assert.ok(projectActPoint(entry,newWindow));
  });
}));

test('잘못된 ID와 클릭 좌표는 저장 전에 거절한다',async()=>fixture(async({directory,host})=>{
  await withExecutionHost(host(directory),async()=>{
    await assert.rejects(addActPoint({...input,id:'../escape'}));
    await assert.rejects(addActPoint({...input,point:{x:NaN,y:.5}}));
    await assert.rejects(addActPoint({...input,point:undefined,box:{x:.9,y:.1,width:.2,height:.2}}));
    assert.deepEqual(await listActPoints(),[]);
    await assert.rejects(removeActPoint('../escape'));
  });
}));

test('오버레이는 XML 문자를 이스케이프하고 축소된 이미지의 실제 표본 클릭과 상자 경계를 표시한다',async()=>fixture(async({directory,source,host,screens})=>{
  const path=join(directory,'large.png');await sharp({create:{width:2400,height:1200,channels:3,background:'#222'}}).png().toFile(path);
  const large={...source,id:'large',path,width:2400,height:1200};screens.set(large.id,large);
  await withExecutionHost(host(directory),async()=>{
    const entry=await addActPoint({...input,snapshotId:large.id,label:'<&"\'> 메뉴',point:undefined,box:{x:.2,y:.2,width:.4,height:.4},jitter:.25});
    const projected=projectActPoint(entry,large,sample([1,0,0,1]))!;
    const original=await readFile(path),base64=await renderActPointOverlay(large,[projected]);
    const {data,info}=await sharp(Buffer.from(base64,'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(info.width,1200);assert.equal(info.height,600);
    const pixel=(x:number,y:number)=>[...data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3)];
    const x=Math.round(projected.point.x*info.width),y=Math.round(projected.point.y*info.height);
    assert.deepEqual(pixel(x,y),[255,64,128]);
    assert.notDeepEqual(pixel(Math.round(projected.box.x*info.width),Math.round((projected.box.y+.1)*info.height)),[34,34,34]);
    assert.deepEqual(await readFile(path),original);
  });
}));

test('가까운 가로 등록 상자의 긴 ID 라벨은 분리되고 실제 클릭 표식을 가리지 않는다',async()=>fixture(async({directory,source,host})=>{
  await withExecutionHost(host(directory),async()=>{
    const points=[];
    for(let index=0;index<4;index++){
      const box={x:.3+index*.05,y:.45,width:.08,height:.1};
      const entry=await addActPoint({...input,id:`nearby-horizontal-long-button-${String.fromCharCode(97+index)}`,point:undefined,box,jitter:0});
      const projected=projectActPoint(entry,source)!;
      closePoint(projected.point,{x:box.x+box.width/2,y:.5});points.push(projected);
    }
    const raster=await overlayRaster(source,points);
    separatedWhiteLabels(raster,points.length);retainedClickMarkers(raster,points.map(point=>point.point));
  });
}));

