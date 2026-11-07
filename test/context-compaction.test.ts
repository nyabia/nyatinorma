// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import type {Model,AssistantMessage} from '@earendil-works/pi-ai';
import {SessionManager} from '@earendil-works/pi-coding-agent';

const model={provider:'new',id:'vision',contextWindow:65536} as Model<any>;
const settings={enabled:true,reserveTokens:8192,keepRecentTokens:12000};
const previous:AssistantMessage={role:'assistant',api:'openai-completions',provider:'old',model:'different',timestamp:1,content:[{type:'text',text:'Previously observed'}],stopReason:'stop',usage:{input:1000,output:5,totalTokens:1005,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};

test('RPC resume compacts visual history while preserving user instructions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ny-compact-'));let summaries=0;
 const server=createServer(async(req,res)=>{
  if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'vision',max_model_len:65536}]}));return;}
  let body='';for await(const chunk of req)body+=chunk;
  const request=JSON.parse(body);assert.equal(request.model,'vision');summaries++;
  res.setHeader('content-type','text/event-stream');
  res.end(`data: ${JSON.stringify({id:'summary',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'Preserved original goal and observed progress.'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}})}\n\ndata: [DONE]\n\n`);
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 try{
  const piDir=join(dir,'pi');await mkdir(piDir);
  await writeFile(join(piDir,'models.json'),JSON.stringify({providers:{new:{baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`,api:'openai-completions',apiKey:'test',models:[{...model,name:'Vision',maxTokens:1024,reasoning:true,input:['text','image'],compat:{supportsReasoningEffort:false,thinkingFormat:'qwen-chat-template',maxTokensField:'max_tokens'}}]}}}));
  await writeFile(join(piDir,'settings.json'),JSON.stringify({defaultProvider:'new',defaultModel:'vision',compaction:settings,quietStartup:true}));
  const session=SessionManager.create(process.cwd(),join(piDir,'sessions'));
  for(let i=0;i<16;i++){
   session.appendMessage({role:'user',timestamp:i,content:`Task constraint ${i}: preserve this request.`});
   session.appendMessage({...previous,timestamp:i+1,content:[{type:'toolCall',id:`call${i}`,name:'ny_observe',arguments:{}}]});
   session.appendMessage({role:'toolResult',timestamp:i+2,toolCallId:`call${i}`,toolName:'ny_observe',isError:false,content:[{type:'text',text:'Observation details '.repeat(1000)},{type:'image',mimeType:'image/png',data:'test'}]});
  }
  session.appendModelChange('new','vision');const file=session.getSessionFile()!;
  const child=spawn(process.execPath,['--import','tsx','src/cli.ts','tui','--mode','rpc','--session',file,'--provider','new','--model','vision'],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,NYATINORMA_DATA_DIR:dir},stdio:'pipe'});
  try{
   const state=await new Promise<any>((done,reject)=>{
    let buffer='';const timer=setTimeout(()=>reject(new Error('Compaction/startup timed out')),12000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.stdout.on('data',chunk=>{buffer+=chunk;for(const line of buffer.split('\n')){try{const e=JSON.parse(line);if(e.id==='state'){clearTimeout(timer);done(e);}}catch{}}});
    child.stdin.write(JSON.stringify({id:'state',type:'get_state'})+'\n');
   });
   assert.equal(state.success,true);assert.equal(state.data.isCompacting,false);
   assert.equal(summaries,0);
   const saved=(await readFile(file,'utf8')).trim().split('\n').map(l=>JSON.parse(l));
   assert.equal(saved.filter(e=>e.type==='compaction').length,1);
   const result=saved.find(e=>e.type==='compaction');
   assert.equal(result.details.strategy,'prune-v1');
   assert.equal(saved.filter(e=>e.type==='message'&&e.message.role==='user').length,16);
  }finally{child.kill('SIGTERM');await new Promise<void>(done=>{if(child.exitCode!==null)done();else child.once('exit',()=>done());});}
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(dir,{recursive:true,force:true});}
});
