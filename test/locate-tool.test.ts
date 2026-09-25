// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';

test('ny_locate defaults to coordinates, archives its private branch, and optional click retains freshness/blocked guards',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-locate-tool-'));process.env.NYATINORMA_DATA_DIR=dir;
  let calls=0;const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw);calls++;
    assert.equal(request.think,false);assert.equal(request.options.num_predict,1);
    assert.ok(request.messages[1].images.length===1);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({logprobs:[{token:'J',top_logprobs:Array.from({length:12},(_,i)=>({token:String.fromCharCode(65+i),logprob:Math.log(i===9?.98:.02/11)}))}]}));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const {default:register}=await import('../extensions/nyatinorma.js');
  const {createRun,selectRun,blockRun}=await import('../src/runs.js');
  try{
    await selectRun((await createRun()).id);await mkdir(join(dir,'captures'),{recursive:true});
    const id='1790000000000-1234abcd',path=join(dir,'captures',id+'.png');
    await sharp({create:{width:400,height:300,channels:3,background:'#445566'}}).png().toFile(path);
    await writeFile(join(dir,'captures',id+'.json'),JSON.stringify({id,path,at:0,width:400,height:300,ocr:[],window:{pid:1,windowId:2,title:'Mock',frame:{x:0,y:0,width:400,height:300}}}));
    const tools=new Map<string,any>();
    await register({on:()=>{},registerTool:(t:any)=>tools.set(t.name,t),registerCommand:()=>{},registerProvider:()=>{}} as any);
    const tool=tools.get('ny_locate');assert.ok(tool);
    const ctx={model:{api:'nyatinorma-native-ollama',id:'mock',baseUrl:`http://127.0.0.1:${(server.address() as any).port}`},modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true})},sessionManager:{getBranch:()=>[{type:'message',id:'user',message:{role:'user',content:'Only locate a point'}}]},ui:{setStatus:()=>{}},hasPendingMessages:()=>false};
    const args={target:'centre button',snapshotId:id};
    const result=await tool.execute('test',args,undefined,undefined,ctx);
    assert.equal(result.details.reason,'located');assert.deepEqual(result.details.point,{x:.5,y:.5});
    assert.equal(result.content.filter((b:any)=>b.type==='image').length,1);
    assert.equal(JSON.parse(result.content[0].text).clicked,false);assert.equal(calls,1);
    const saved=await readdir(join(dir,'locate',result.details.searchId));assert.deepEqual(saved.sort(),['0.json','0.png']);
    await assert.rejects(tool.execute('test',{...args,click:true},undefined,undefined,ctx),/requires anchor/);assert.equal(calls,1);
    // An explicitly requested click still cannot use a pre-resume screenshot.
    await assert.rejects(tool.execute('test',{...args,click:true,anchor:{x:0,y:0,width:.2,height:.2},expectation:'button opens'},undefined,undefined,ctx),/새 화면/);assert.equal(calls,2);
    await blockRun({reason:'Missing access',attempts:[],needed:'Human fixes access'});
    await assert.rejects(tool.execute('test',args,undefined,undefined,ctx),/run_blocked/);assert.equal(calls,2);
  }finally{await selectRun(null);server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));delete process.env.NYATINORMA_DATA_DIR;await rm(dir,{recursive:true,force:true});}
});
