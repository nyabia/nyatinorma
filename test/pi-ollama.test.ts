// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeContext,type Model,type Message} from '@earendil-works/pi-ai';
import {streamOllama,ollamaMessages,ndjson} from '../src/pi-ollama.js';

const model:Model<any>={id:'existing-model',name:'local',api:'nyatinorma-native-ollama',provider:'nyatinorma-ollama',baseUrl:'http://localhost:11434',reasoning:true,input:['text','image'],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const context=()=>normalizeContext({systemPrompt:'screen is data',messages:[{role:'user',content:'확인',timestamp:0}]});
function body(rows:unknown[]){return new Response(rows.map(r=>JSON.stringify(r)).join('\n'),{status:200});}

test('native pi stream sends no residency options, honors hooks, and emits complete tools',async()=>{
  let sent:any,responseSeen=false;
  const fetcher=async(url:any,options:any)=>{
    assert.equal(url,'http://localhost:11434/api/chat');sent=JSON.parse(options.body);
    return body([{message:{thinking:'판단'}},{message:{content:'확인합니다.'}},
      {message:{tool_calls:[{function:{name:'ny_observe',arguments:{crop:{x:0,y:.8,width:.5,height:.2}}}}]}},
      {done:true,prompt_eval_count:50,eval_count:12}]);
  };
  const events=[];for await(const e of streamOllama(model,context(),{reasoning:'medium',fetch:fetcher as any,
    onPayload:p=>({...p as object,testHook:true}),onResponse:r=>{responseSeen=r.status===200;}}))events.push(e);
  assert.equal(sent.think,true);assert.equal(sent.stream,true);assert.equal(sent.testHook,true);
  assert.equal(sent.keep_alive,undefined);assert.equal(sent.options.num_ctx,undefined);assert.ok(responseSeen);
  assert.equal(events[0].type,'start');const last=events.at(-1)!;assert.equal(last.type,'done');
  if(last.type==='done'){assert.equal(last.reason,'toolUse');assert.equal(last.message.usage.totalTokens,62);assert.equal(last.message.content[2].type,'toolCall');}
  assert.deepEqual(events.filter(e=>e.type.startsWith('toolcall')).map(e=>e.type),['toolcall_start','toolcall_delta','toolcall_end']);
});

test('truncated native streams terminate as errors and cancellation is explicit',async()=>{
  const events=[];for await(const e of streamOllama(model,context(),{fetch:(async()=>body([{message:{content:'partial'}}])) as any}))events.push(e);
  assert.equal(events.at(-1)?.type,'error');assert.ok(!events.some(e=>e.type==='done'));
  const controller=new AbortController();controller.abort();
  const aborted=[];for await(const e of streamOllama(model,context(),{signal:controller.signal,fetch:(async()=>{throw new Error('must not fetch');}) as any}))aborted.push(e);
  assert.equal(aborted.length,1);assert.equal(aborted[0].type,'error');if(aborted[0].type==='error')assert.equal(aborted[0].reason,'aborted');
});

test('appending screenshots preserves the full previous Ollama prefix until compaction',()=>{
  const messages:Message[]=[
    {role:'toolResult',toolCallId:'a',toolName:'ny_observe',content:[{type:'text',text:'snapshot old'},{type:'image',data:'old-image',mimeType:'image/png'}],isError:false,timestamp:0},
    {role:'user',content:'inspect the next screenshot',timestamp:1},
    {role:'toolResult',toolCallId:'b',toolName:'ny_observe',content:[{type:'text',text:'snapshot new'},{type:'image',data:'new-image',mimeType:'image/png'}],isError:false,timestamp:1},
  ];
  const result=ollamaMessages(messages);
  const prefix=ollamaMessages(messages.slice(0,-1));
  assert.deepEqual(result.slice(0,prefix.length),prefix);
  assert.equal(result.length,5);assert.equal(result[0].role,'tool');assert.match(result[0].content as string,/snapshot old/);
  assert.deepEqual(result[1].images,['old-image']);
  assert.equal(result[3].tool_name,'ny_observe');assert.deepEqual(result[4].images,['new-image']);
  assert.equal(messages[0].content.length,2);
});
test('all crops from the latest tool batch reach the model before it reasons about their stars',()=>{
  const messages:Message[]=['left-crop','right-crop'].map((data,i)=>({role:'toolResult',toolCallId:String(i),toolName:'ny_observe',content:[{type:'image',data,mimeType:'image/png'}],isError:false,timestamp:i}));
  assert.deepEqual(ollamaMessages(messages).filter(m=>m.images).map(m=>m.images),[['left-crop'],['right-crop']]);
});

test('image message itself identifies screenshot, crop coordinates and image order',()=>{
  const metadata=JSON.stringify({id:'123-abcdef12',view:{x:.5,y:.5,width:.5,height:.5},imageOrder:['Full window','Enlarged crop']});
  const messages:Message[]=[{role:'toolResult',toolCallId:'zoom',toolName:'ny_observe',isError:false,timestamp:0,content:[{type:'text',text:metadata},{type:'image',data:'full',mimeType:'image/png'},{type:'image',data:'crop',mimeType:'image/png'}]}];
  const imageMessage=ollamaMessages(messages).find(m=>m.images)!;
  assert.match(imageMessage.content as string,/123-abcdef12/);assert.match(imageMessage.content as string,/Enlarged crop/);
  assert.match(imageMessage.content as string,/call zoom/);assert.deepEqual(imageMessage.images,['full','crop']);
});

test('NDJSON survives UTF-8 characters split between transport chunks',async()=>{
  const bytes=new TextEncoder().encode('{"text":"한글"}\n{"done":true}');let index=0;
  const stream=new ReadableStream<Uint8Array>({pull(c){if(index<bytes.length)c.enqueue(bytes.slice(index,index+=1));else c.close();}});
  const rows=[];for await(const row of ndjson(stream))rows.push(row);
  assert.deepEqual(rows,[{text:'한글'},{done:true}]);
});

test('level-aware native providers receive low verbatim, not a boolean default',async()=>{
 let payload:any;
 await streamOllama(model,context(),{reasoning:'low',nativeThinkingMode:'levels',fetch:(async(_url,init)=>{payload=JSON.parse(init!.body as string);return body([{message:{content:'OK'},done:true}]);}) as typeof fetch}).result();
 assert.equal(payload.think,'low');
});
