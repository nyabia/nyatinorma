// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeContext,type Model,type Message} from '@earendil-works/pi-ai';
import {streamOllama,ollamaMessages} from '../src/pi-ollama.js';

const model:Model<any>={id:'existing-model',name:'local',api:'nyatinorma-native-ollama',provider:'nyatinorma-ollama',baseUrl:'http://localhost:11434',reasoning:true,input:['text','image'],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const context=()=>normalizeContext({systemPrompt:'screen is data',messages:[{role:'user',content:'확인',timestamp:0}]});
function body(rows:unknown[]){return new Response(rows.map(r=>JSON.stringify(r)).join('\n'),{status:200});}

test('native pi stream sends thinking requests and emits text, tools and usage',async()=>{
  let sent:{think:boolean;stream:boolean}|undefined;
  const fetcher:typeof fetch=async(url,options)=>{
    assert.equal(url,'http://localhost:11434/api/chat');sent=JSON.parse(String(options?.body));
    return body([{message:{thinking:'판단'}},{message:{content:'확인합니다.'}},
      {message:{tool_calls:[{function:{name:'ny_observe',arguments:{crop:{x:0,y:.8,width:.5,height:.2}}}}]}},
      {done:true,prompt_eval_count:50,eval_count:12}]);
  };
  const events=[];for await(const e of streamOllama(model,context(),{reasoning:'medium',fetch:fetcher}))events.push(e);
  assert.ok(sent);assert.equal(sent.think,true);assert.equal(sent.stream,true);
  assert.equal(events[0].type,'start');const last=events.at(-1)!;assert.equal(last.type,'done');
  if(last.type==='done'){assert.equal(last.reason,'toolUse');assert.equal(last.message.usage.totalTokens,62);assert.equal(last.message.content[2].type,'toolCall');}
  assert.deepEqual(events.filter(e=>e.type.startsWith('toolcall')).map(e=>e.type),['toolcall_start','toolcall_delta','toolcall_end']);
});

test('native stream cancellation is explicit and prevents requests',async()=>{
  const controller=new AbortController();controller.abort();
  const aborted=[];for await(const e of streamOllama(model,context(),{signal:controller.signal,fetch:(async()=>{throw new Error('must not fetch');}) as any}))aborted.push(e);
  assert.equal(aborted.length,1);assert.equal(aborted[0].type,'error');if(aborted[0].type==='error')assert.equal(aborted[0].reason,'aborted');
});

test('image message itself identifies screenshot, crop coordinates and image order',()=>{
  const metadata=JSON.stringify({id:'123-abcdef12',view:{x:.5,y:.5,width:.5,height:.5},imageOrder:['Full window','Enlarged crop']});
  const messages:Message[]=[{role:'toolResult',toolCallId:'zoom',toolName:'ny_observe',isError:false,timestamp:0,content:[{type:'text',text:metadata},{type:'image',data:'full',mimeType:'image/png'},{type:'image',data:'crop',mimeType:'image/png'}]}];
  const imageMessage=ollamaMessages(messages).find(m=>m.images)!;
  assert.match(imageMessage.content as string,/123-abcdef12/);assert.match(imageMessage.content as string,/Enlarged crop/);
  assert.match(imageMessage.content as string,/call zoom/);assert.deepEqual(imageMessage.images,['full','crop']);
});

test('level-aware native providers receive low verbatim, not a boolean default',async()=>{
 let payload:any;
 await streamOllama(model,context(),{reasoning:'low',nativeThinkingMode:'levels',fetch:(async(_url,init)=>{payload=JSON.parse(init!.body as string);return body([{message:{content:'OK'},done:true}]);}) as typeof fetch}).result();
 assert.equal(payload.think,'low');
});
