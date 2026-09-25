// SPDX-License-Identifier: MIT OR Apache-2.0
import {buildSessionContext,estimateTokens,calculateContextTokens,type CompactionResult,type SessionBeforeCompactEvent} from '@earendil-works/pi-coding-agent';
import type {Model} from '@earendil-works/pi-ai';
import {contextTokens,pruneCompaction,recoveryTarget,trimCompaction} from './prune-compaction.js';

/** Calibrate against the latest completed call of THIS model after the last
 * compaction. Other models and pre-compaction usage describe a different input.
 */
export function contextUsageScale(event:SessionBeforeCompactEvent,model:Model<any>){
  const entries=event.branchEntries;
  const boundary=entries.findLastIndex(e=>e.type==='compaction');
  for(let i=entries.length-1;i>boundary;i--){
    const e=entries[i];if(e.type!=='message'||e.message.role!=='assistant')continue;
    const m=e.message;if(m.provider!==model.provider||m.model!==model.id||m.stopReason==='error'||m.stopReason==='aborted')continue;
    const actual=calculateContextTokens(m.usage),estimated=buildSessionContext(entries.slice(0,i+1)).messages.reduce((n,m)=>n+estimateTokens(m),0);
    if(actual>0&&estimated>0)return Math.max(1,actual/estimated);
  }
  return 1;
}

/** Each method is attempted at most once per boundary. No per-request prefix edits. */
export async function compactWithFallback(event:SessionBeforeCompactEvent,model:Model<any>,summarize:()=>Promise<CompactionResult>){
  event.signal.throwIfAborted();
  const before=contextTokens(event),usageScale=contextUsageScale(event,model),target=Math.floor(recoveryTarget(event,model)/usageScale);
  const summaryBudget=Math.min(6000,Math.floor(model.contextWindow*.1/usageScale));
  const summaryTokens=(result:CompactionResult)=>estimateTokens({role:'user',timestamp:0,content:result.summary});
  const previous=event.branchEntries.findLast(e=>e.type==='compaction');
  const previousDetails=previous?.type==='compaction'?previous.details as {strategy?:string;mechanicalStreak?:number}|undefined:undefined;
  const streak=previousDetails?.strategy==='prune-v1'||previousDetails?.strategy==='trim-v1'?previousDetails.mechanicalStreak??1:0;
  const minSavings=Math.min(2048,Math.ceil(model.contextWindow*0.03));
  const acceptable=(result:CompactionResult)=>{
    const after=contextTokens(event,result);
    return after<=target&&summaryTokens(result)<=summaryBudget&&before-after>=minSavings;
  };
  const finish=(result:CompactionResult,strategy:string,failure?:string)=>{
    event.signal.throwIfAborted();
    return {...result,tokensBefore:before,estimatedTokensAfter:contextTokens(event,result),details:{...result.details as object,strategy,reason:event.reason,targetTokens:target,summaryFailure:failure,usageScale,summaryBudgetTokens:summaryBudget,mechanicalStreak:strategy==='summary-v1'?0:streak+1}};
  };
  const pruned=pruneCompaction(event);
  // /compact with instructions explicitly requests a semantic rewrite.
  if(!event.customInstructions?.trim()&&streak<2&&acceptable(pruned))return finish(pruned,'prune-v1');
  let failure:string;
  try{
    const summary=await summarize();
    event.signal.throwIfAborted();
    if(!summary.summary.trim()||summary.firstKeptEntryId!==event.preparation.firstKeptEntryId)throw new Error('Invalid summary or changed retention boundary');
    if(acceptable(summary))return finish(summary,'summary-v1');
    failure='Summary did not reclaim enough context';
  }catch(error){
    event.signal.throwIfAborted();
    if(error instanceof Error&&error.name==='AbortError')throw error;
    failure=error instanceof Error?error.message:String(error);
  }
  const trimmed=trimCompaction(event,pruned,Math.min(target,contextTokens(event,{...pruned,summary:''})+summaryBudget));
  if(!acceptable(trimmed))throw new Error('Compaction cannot reclaim enough context without losing protected instructions or the recent turn. Start a new session or use a larger context.');
  return finish(trimmed,'trim-v1',failure);
}
