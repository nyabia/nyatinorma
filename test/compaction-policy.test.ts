// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionManager,buildSessionContext,type SessionBeforeCompactEvent,type SessionEntry,type CompactionResult} from '@earendil-works/pi-coding-agent';
import type {Model,AssistantMessage} from '@earendil-works/pi-ai';
import {compactWithFallback} from '../src/compaction-policy.js';

const model={id:'test',provider:'test',contextWindow:32768,maxTokens:4096} as Model<any>;
const assistant=(text:string):AssistantMessage=>({role:'assistant',api:'openai-completions',provider:'test',model:'test',timestamp:0,content:[{type:'text',text}],stopReason:'stop',usage:{input:1,output:1,totalTokens:2,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
function boundary(entries:SessionEntry[],firstKeptEntryId:string):SessionBeforeCompactEvent{
  return {type:'session_before_compact',branchEntries:entries,reason:'threshold',willRetry:false,signal:new AbortController().signal,preparation:{firstKeptEntryId,tokensBefore:1,messagesToSummarize:[],turnPrefixMessages:[],isSplitTurn:false,settings:{enabled:true,reserveTokens:4096,keepRecentTokens:4000},fileOps:{read:new Set(),written:new Set(),edited:new Set()}}};
}
function fixture(kind:'tools'|'text'='tools'){
  const session=SessionManager.inMemory();
  session.appendMessage({role:'user',timestamp:0,content:'Original goal: inspect the app. Never purchase anything.'});
  for(let i=0;i<12;i++){
    session.appendMessage({...assistant(''),content:[{type:'text',text:kind==='text'?'Old execution detail '.repeat(700):'Observed a screen.'},{type:'toolCall',id:`call${i}`,name:'ny_observe',arguments:{}}]});
    session.appendMessage({role:'toolResult',timestamp:0,toolName:'ny_observe',toolCallId:`call${i}`,isError:false,content:[{type:'text',text:'Old output '.repeat(1500)},{type:'image',data:'archived-image',mimeType:'image/png'}]});
  }
  session.appendMessage({role:'user',timestamp:0,content:'Correction: stop after one item.'});
  const kept=session.appendMessage({...assistant('Recent state'),content:[{type:'toolCall',id:'recent',name:'ny_observe',arguments:{}}]});
  session.appendMessage({role:'toolResult',timestamp:0,toolName:'ny_observe',toolCallId:'recent',isError:false,content:[{type:'image',data:'recent-image',mimeType:'image/png'}]});
  return {session,event:boundary(session.getBranch(),kept)};
}
const checkpoint=(event:SessionBeforeCompactEvent):CompactionResult=>({summary:'Goal and user constraints; confirmed observations; outstanding work.',firstKeptEntryId:event.preparation.firstKeptEntryId,tokensBefore:1});

test('pruning preserves instructions and raw tool pairs; source journal is unchanged',async()=>{
  const {event}=fixture(),original=JSON.stringify(event.branchEntries);
  const result=await compactWithFallback(event,model,async()=>{throw new Error('Should not call model');});
  assert.equal(result.details.strategy,'prune-v1');
  assert.match(result.summary,/Never purchase anything/);assert.match(result.summary,/stop after one item/);
  assert.ok(result.estimatedTokensAfter<=result.details.targetTokens);
  assert.equal(JSON.stringify(event.branchEntries),original);
  const entries=[...event.branchEntries,{...result,type:'compaction' as const,id:'compact',parentId:event.branchEntries.at(-1)!.id,timestamp:new Date(0).toISOString()}];
  const messages=buildSessionContext(entries).messages;
  assert.equal(messages.at(-1)?.role,'toolResult');assert.equal(messages.at(-2)?.role,'assistant');
  assert.ok(JSON.stringify(messages).includes('recent-image'));assert.ok(!JSON.stringify(messages).includes('archived-image'));
});

test('accumulated assistant text escalates to semantic summary',async()=>{
  const {event}=fixture('text');
  let calls=0;const result=await compactWithFallback(event,model,async()=>{calls++;return checkpoint(event);});
  assert.equal(result.details.strategy,'summary-v1');assert.equal(calls,1);
});

test('aborted semantic compaction cannot commit a result',async()=>{
  const {event}=fixture('text'),controller=new AbortController();event.signal=controller.signal;
  await assert.rejects(compactWithFallback(event,model,async()=>{controller.abort();return checkpoint(event);}),{name:'AbortError'});
});
