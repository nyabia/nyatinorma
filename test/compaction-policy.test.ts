// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionManager,buildSessionContext,type SessionBeforeCompactEvent,type SessionEntry,type CompactionResult} from '@earendil-works/pi-coding-agent';
import type {Model,AssistantMessage} from '@earendil-works/pi-ai';
import {compactWithFallback,contextUsageScale} from '../src/compaction-policy.js';
import {pruneCompaction,contextTokens,recalledText,visualCompactionBoundary} from '../src/prune-compaction.js';
import registerCompaction from '../extensions/prune-compaction.js';

const model={id:'test',provider:'test',contextWindow:32768,maxTokens:4096} as Model<any>;
const assistant=(text:string):AssistantMessage=>({role:'assistant',api:'openai-completions',provider:'test',model:'test',timestamp:0,content:[{type:'text',text}],stopReason:'stop',usage:{input:1,output:1,totalTokens:2,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
function boundary(entries:SessionEntry[],firstKeptEntryId:string):SessionBeforeCompactEvent{
  return {type:'session_before_compact',branchEntries:entries,reason:'threshold',willRetry:false,signal:new AbortController().signal,preparation:{firstKeptEntryId,tokensBefore:1,messagesToSummarize:[],turnPrefixMessages:[],isSplitTurn:false,settings:{enabled:true,reserveTokens:4096,keepRecentTokens:4000},fileOps:{read:new Set(),written:new Set(),edited:new Set()}}};
}
function fixture(kind:'tools'|'text'|'user'='tools'){
  const session=SessionManager.inMemory();
  session.appendMessage({role:'user',timestamp:0,content:kind==='user'?'Mandatory instruction '.repeat(8000):'Original goal: inspect the app. Never purchase anything.'});
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

test('accumulated assistant text escalates to semantic summary; manual focus also skips prune',async()=>{
  for(const kind of ['text','tools'] as const){
    const {event}=fixture(kind);if(kind==='tools')event.customInstructions='Focus on unresolved work';
    let calls=0;const result=await compactWithFallback(event,model,async()=>{calls++;return checkpoint(event);});
    assert.equal(result.details.strategy,'summary-v1');assert.equal(calls,1);
  }
});

test('summary token cap and inadequate summary each fall back once to bounded truncation',async()=>{
  for(const failure of ['cap','no-progress']){
    const {event}=fixture('text');let calls=0;
    const result=await compactWithFallback(event,model,async()=>{calls++;if(failure==='cap')throw new Error('generation hit the token cap');return pruneCompaction(event);});
    assert.equal(calls,1);assert.equal(result.details.strategy,'trim-v1');
    assert.ok(result.estimatedTokensAfter<=result.details.targetTokens);
    assert.match(result.summary,/Never purchase anything/);assert.match(result.summary,/stop after one item/);
    assert.ok((result.details as any).droppedRecords>0);assert.ok(result.details.summaryFailure);
  }
});

test('repeated pruning flattens prior records, then growing text forces a new semantic summary',async()=>{
  const {session,event}=fixture();const first=await compactWithFallback(event,model,async()=>checkpoint(event));
  session.appendCompaction(first.summary,first.firstKeptEntryId,first.tokensBefore,first.details);
  session.appendMessage(assistant('Old details '.repeat(9000)));
  const kept=session.appendMessage({role:'user',timestamp:1,content:'Continue with the same limits.'});
  const next=boundary(session.getBranch(),kept),pruned=pruneCompaction(next);
  assert.equal(pruned.summary.split('Original goal:').length-1,1);
  let calls=0;const result=await compactWithFallback(next,model,async()=>{calls++;return checkpoint(next);});
  assert.equal(calls,1);assert.equal(result.details.strategy,'summary-v1');
  assert.ok(contextTokens(next,result)<contextTokens(next));
});

test('abort cannot commit or trim; irreducible protected input fails explicitly',async()=>{
  const {event}=fixture('text'),controller=new AbortController();event.signal=controller.signal;
  await assert.rejects(compactWithFallback(event,model,async()=>{controller.abort();return checkpoint(event);}),{name:'AbortError'});
  const huge=fixture('user').event;
  await assert.rejects(compactWithFallback(huge,model,async()=>{throw new Error('token cap');}),/사용자 지시/);
});

test('recall exposes archived text and selected image without executing actions; failed hook cancels default retry',async()=>{
  const {session,event}=fixture('user');const handlers=new Map<string,any>();let recall:any;
  registerCompaction({on:(name:string,handler:any)=>handlers.set(name,handler),registerTool:(tool:any)=>{recall=tool;}} as any);
  const ctx={model,sessionManager:session,ui:{notify:()=>{}},modelRegistry:{streamSimple:()=>{throw new Error('token cap');}}};
  const entry=event.branchEntries.find(e=>e.type==='message'&&e.message.role==='toolResult')!;
  assert.ok(!recalledText(entry).includes('archived-image'));
  const result=await recall.execute('r',{entryId:entry.id,imageIndex:0,maxChars:200},undefined,undefined,ctx);
  assert.equal(result.content.length,2);assert.equal(result.content[1].data,'archived-image');
  const index=await recall.execute('r',{query:'Old output'},undefined,undefined,ctx);assert.equal(index.details.count,12);
  const page=await recall.execute('r',{beforeEntryId:entry.id,query:'Old output'},undefined,undefined,ctx);assert.equal(page.details.count,0);
  await assert.rejects(recall.execute('r',{entryId:entry.id,imageIndex:1},undefined,undefined,ctx),/Image index unavailable/);
  assert.deepEqual(await handlers.get('session_before_compact')(event,ctx),{cancel:true});
  const cancelled=new AbortController();cancelled.abort();event.signal=cancelled.signal;
  assert.deepEqual(await handlers.get('session_before_compact')(event,ctx),{cancel:true});
});


test('repeated small mechanical checkpoints force semantic summary even below the size limit',async()=>{
  const {session,event}=fixture();let next=event;
  for(let i=0;i<3;i++){
    let summaries=0;const result=await compactWithFallback(next,model,async()=>{summaries++;return checkpoint(next);});
    assert.equal(summaries,i===2?1:0);assert.equal(result.details.strategy,i===2?'summary-v1':'prune-v1');
    session.appendCompaction(result.summary,result.firstKeptEntryId,result.tokensBefore,result.details);
    session.appendMessage({...assistant(''),content:[{type:'toolCall',id:`more${i}`,name:'ny_observe',arguments:{}}]});
    session.appendMessage({role:'toolResult',timestamp:1,toolName:'ny_observe',toolCallId:`more${i}`,content:[{type:'text',text:'obsolete '.repeat(8000)}],isError:false});
    const kept=session.appendMessage({role:'user',timestamp:2,content:'Continue under the same constraints.'});
    next=boundary(session.getBranch(),kept);
  }
});

test('same-model server usage tightens budgets; old-model and pre-compaction usage do not',()=>{
  const {session}=fixture();const m=assistant('recent');m.usage.totalTokens=200000;
  session.appendMessage(m);let event=boundary(session.getBranch(),session.getLeafId()!);
  const scale=contextUsageScale(event,model);assert.ok(scale>1);
  assert.equal(contextUsageScale(event,{...model,id:'other'}),1);
  session.appendCompaction('checkpoint',event.preparation.firstKeptEntryId,200000,{strategy:'summary-v1'});
  event=boundary(session.getBranch(),session.getLeafId()!);assert.equal(contextUsageScale(event,model),1);
});

test('visual cleanup advances the raw tail without splitting tool pairs or dropping the latest image exchange',()=>{
  const {event}=fixture();const first=event.branchEntries.find(e=>e.type==='message'&&e.message.role==='assistant')!;
  event.preparation.firstKeptEntryId=first.id;event.preparation.settings.keepRecentTokens=20000;
  const original=JSON.stringify(event),shortened=visualCompactionBoundary(event);
  assert.notEqual(shortened.preparation.firstKeptEntryId,first.id);
  const cut=shortened.branchEntries.findIndex(e=>e.id===shortened.preparation.firstKeptEntryId);
  const tail=shortened.branchEntries.slice(cut);
  assert.ok(JSON.stringify(tail).includes('recent-image'));
  assert.ok(!JSON.stringify(tail).includes('archived-image'));
  assert.equal(tail[0].type,'message');assert.notEqual((tail[0] as any).message.role,'toolResult');
  const call=tail.findIndex(e=>e.type==='message'&&e.message.role==='assistant');
  const result=tail.findIndex(e=>e.type==='message'&&e.message.role==='toolResult');assert.ok(call>=0&&result>call);
  assert.equal(JSON.stringify(event),original);
  assert.ok(shortened.preparation.messagesToSummarize.length>0);
});
