// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import sharp from 'sharp';
import {once} from 'node:events';
import type {Snapshot,Candidate} from '../src/types.js';
import type {Continuation} from '../src/execution-contract.js';
import type {ExecutionHost} from '../src/host-context.js';

test('ny_locate returns archived coordinates without input, clicks exactly once when requested, and retains blocked guards',async t=>{
  const scratch=resolve(import.meta.dirname,'../.tmpdl');await mkdir(scratch,{recursive:true});
  const previousDataDir=process.env.NYATINORMA_DATA_DIR,dir=await mkdtemp(join(scratch,'ny-locate-tool-'));process.env.NYATINORMA_DATA_DIR=dir;
  const requests:any[]=[];const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw);requests.push(request);
    const aliases=[...request.messages.at(-1).content.matchAll(/^([A-Z]) = /gm)].map(match=>match[1]);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({logprobs:[{token:aliases[0],top_logprobs:aliases.map((token,i)=>({token,logprob:Math.log(i===0?.98:.02/(aliases.length-1))}))}]}));
  });
  const listening=once(server,'listening');server.listen(0,'127.0.0.1');await listening;
  // The isolated data directory must be set before config.ts is first loaded.
  const {default:register}=await import('../extensions/nyatinorma.js');
  const {createRun,selectRun,blockRun}=await import('../src/runs.js');
  const {actionDefaults}=await import('../src/action-runtime.js');
  const {withExecutionHost}=await import('../src/host-context.js');
  const {defaults}=await import('../src/config.js');
  const continuations=new Map<string,Continuation>();let active:string|undefined,source:Snapshot,after:Snapshot,captures=0;
  const host:ExecutionHost={id:dir,inputScope:dir,config:async()=>({...defaults}),loadContinuation:async(id?:string)=>structuredClone(continuations.get(id??active??'')),saveContinuation:async value=>{continuations.set(value.id,structuredClone(value));active=value.id;},snapshot:async id=>[source,after].find(s=>s.id===id)};
  const inputs:{action:Candidate;snapshot:Snapshot}[]=[];
  t.mock.method(actionDefaults,'capture',async()=>{captures++;return inputs.length?after:source;});
  t.mock.method(actionDefaults,'execute',async(action:Candidate,snapshot:Snapshot)=>{inputs.push({action,snapshot});return {focusPreserved:true};});
  try{
    await withExecutionHost(host,async()=>{
    await selectRun((await createRun()).id);await mkdir(join(dir,'captures'),{recursive:true});
    const id='1790000000000-1234abcd',path=join(dir,'captures',id+'.png');
    await sharp(Buffer.from('<svg width="400" height="300"><rect width="400" height="300" fill="#445566"/><rect x="150" y="100" width="100" height="100" fill="blue"/><rect x="20" y="20" width="50" height="40" fill="red"/></svg>')).png().toFile(path);
    source={id,path,at:Date.now(),width:400,height:300,ocr:[],window:{pid:1,windowId:2,title:'Mock',frame:{x:0,y:0,width:400,height:300}}};
    await writeFile(join(dir,'captures',id+'.json'),JSON.stringify(source));
    after={...source,id:'1790000000000-abcd1234',path:join(dir,'captures','1790000000000-abcd1234.png')};
    await sharp(Buffer.from('<svg width="400" height="300"><rect width="400" height="300" fill="#445566"/><rect x="80" y="50" width="240" height="200" fill="green"/></svg>')).png().toFile(after.path);
    await writeFile(join(dir,'captures',after.id+'.json'),JSON.stringify(after));
    const tools=new Map<string,any>();
    await register({on:()=>{},registerTool:(t:any)=>tools.set(t.name,t),registerCommand:()=>{},registerProvider:()=>{}} as any);
    const tool=tools.get('ny_locate');assert.ok(tool);
    const ctx={model:{api:'nyatinorma-native-ollama',id:'mock',baseUrl:`http://127.0.0.1:${(server.address() as any).port}`},modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true})},sessionManager:{getBranch:()=>[{type:'message',id:'user',message:{role:'user',content:'Unrelated historical conversation marker'}}]},ui:{setStatus:()=>{}},hasPendingMessages:()=>false};
    const args={target:'centre blue button',snapshotId:id,constraints:'Exclude red targets'};
    const result=await tool.execute('test',args,undefined,undefined,ctx);
    assert.equal(result.details.reason,'located');assert.deepEqual(result.details.point,{x:.5,y:.5});
    assert.equal(result.content.filter((b:any)=>b.type==='image').length,1);
    assert.equal(JSON.parse(result.content[0].text).clicked,false);assert.equal(inputs.length,0);assert.equal(captures,0);
    assert.ok(requests.length>0);
    for(const request of requests){
      assert.equal(request.think,false);assert.equal(request.options.num_predict,1);
      const user=request.messages.at(-1);assert.equal(user.images.length,1);
      assert.ok(!user.content.includes('Unrelated historical conversation marker'));assert.ok(user.content.includes(args.constraints));
    }
    const archive=join(dir,'locate',result.details.searchId),saved=await readdir(archive),records=saved.filter(name=>name.endsWith('.json'));
    assert.ok(records.length>0);
    for(const name of records){
      assert.ok(saved.includes(name.replace(/\.json$/,'.png')));
      const record=JSON.parse(await readFile(join(archive,name),'utf8'));
      assert.equal(record.snapshotId,id);assert.deepEqual(record.point,result.details.point);
    }
    const beforeInvalid=requests.length;
    await assert.rejects(tool.execute('test',{...args,click:true},undefined,undefined,ctx),/requires expectation/);
    assert.equal(requests.length,beforeInvalid);assert.equal(inputs.length,0);assert.equal(captures,0);
    const clicked=await tool.execute('test',{...args,click:true,expectation:'green panel opens'},undefined,undefined,ctx);
    assert.equal(clicked.details.clicked,true);assert.equal(clicked.details.status,'done',clicked.details.error);
    assert.equal(inputs.length,1,'An explicitly requested click must be dispatched exactly once');
    const sent=inputs[0];assert.equal(sent.action.kind,'click');
    assert.deepEqual({x:sent.action.box!.x+sent.action.box!.width/2,y:sent.action.box!.y+sent.action.box!.height/2},clicked.details.locatedPoint);
    assert.equal(clicked.details.lastInput.actionId,sent.action.id);assert.equal(clicked.details.lastInput.outcome,'observed');
    assert.equal(sent.snapshot.id,source.id);assert.equal(clicked.details.snapshot.id,after.id);
    await blockRun({reason:'Missing access',attempts:[],needed:'Human fixes access'});
    const beforeBlocked=requests.length,capturesBeforeBlocked=captures;
    await assert.rejects(tool.execute('test',{...args,click:true,expectation:'button opens'},undefined,undefined,ctx),/run_blocked/);
    await assert.rejects(tool.execute('test',args,undefined,undefined,ctx),/run_blocked/);
    assert.equal(requests.length,beforeBlocked);assert.equal(captures,capturesBeforeBlocked);assert.equal(inputs.length,1);
    });
  }finally{await selectRun(null);server.closeAllConnections();const closed=once(server,'close');server.close();await closed;if(previousDataDir===undefined)delete process.env.NYATINORMA_DATA_DIR;else process.env.NYATINORMA_DATA_DIR=previousDataDir;await rm(dir,{recursive:true,force:true});}
});
