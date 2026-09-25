// SPDX-License-Identifier: MIT OR Apache-2.0
import type {CompactionResult,SessionBeforeCompactEvent} from '@earendil-works/pi-coding-agent';
import type {Model} from '@earendil-works/pi-ai';
import {contextTokens,pruneCompaction,recoveryTarget,trimCompaction} from './prune-compaction.js';

/** Each method is attempted at most once per boundary. No per-request prefix edits. */
export async function compactWithFallback(event:SessionBeforeCompactEvent,model:Model<any>,summarize:()=>Promise<CompactionResult>){
  event.signal.throwIfAborted();
  const before=contextTokens(event),target=recoveryTarget(event,model);
  const minSavings=Math.min(2048,Math.ceil(model.contextWindow*0.03));
  const acceptable=(result:CompactionResult)=>{
    const after=contextTokens(event,result);
    return after<=target&&before-after>=minSavings;
  };
  const finish=(result:CompactionResult,strategy:string,failure?:string)=>{
    event.signal.throwIfAborted();
    return {...result,tokensBefore:before,estimatedTokensAfter:contextTokens(event,result),details:{...result.details as object,strategy,reason:event.reason,targetTokens:target,summaryFailure:failure}};
  };
  const pruned=pruneCompaction(event);
  // /compact with instructions explicitly requests a semantic rewrite.
  if(!event.customInstructions?.trim()&&acceptable(pruned))return finish(pruned,'prune-v1');
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
  const trimmed=trimCompaction(event,pruned,target);
  if(!acceptable(trimmed))throw new Error('Compaction cannot reclaim enough context without losing protected instructions or the recent turn. Start a new session or use a larger context.');
  return finish(trimmed,'trim-v1',failure);
}
