// SPDX-License-Identifier: MIT OR Apache-2.0
import {Type} from 'typebox';
import {compact,defineTool,type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {config} from '../src/config.js';
import {recalledText} from '../src/prune-compaction.js';
import {compactWithFallback} from '../src/compaction-policy.js';

export default function registerPruneCompaction(pi:ExtensionAPI){
  pi.on('session_before_compact',async(event,ctx)=>{
    try{
      event.signal.throwIfAborted();
      if(!ctx.model)throw new Error('No active model for compaction budget');
      const model=ctx.model;
      const compaction=await compactWithFallback(event,model,async()=>{
        ctx.ui.notify('도구 결과 정리만으로 부족하여 대화와 이전 요약을 다시 요약합니다.','info');
        const timeout=(await config()).ollamaTimeoutSeconds*1000;
        const signal=AbortSignal.any([event.signal,AbortSignal.timeout(timeout)]);
        // Reuse pi's summarizer and configured provider/auth transport. Disable
        // summary reasoning so it does not consume the checkpoint's output budget.
        return compact(event.preparation,model,undefined,undefined,
          'Write a concise checkpoint, ideally under 800 words. Preserve current user constraints, confirmed progress, unresolved work, and identifiers needed to resume. Distinguish observation from inference. Merge the previous summary instead of accumulating it. '+(event.customInstructions??''),
          signal,'off',(m,context,options)=>ctx.modelRegistry.streamSimple(m,context,options));
      });
      const label=compaction.details.strategy==='prune-v1'?'도구 결과 정리':compaction.details.strategy==='summary-v1'?'의미 요약':'오래된 실행 내역 절단 (요약 실패/절감 부족)';
      ctx.ui.notify(`${label}: 약 ${compaction.tokensBefore.toLocaleString()} → ${compaction.estimatedTokensAfter.toLocaleString()} 토큰. 원본 기록은 보존됩니다.`,compaction.details.strategy==='trim-v1'?'warning':'info');
      return {compaction};
    }catch(error){
      // pi reports extension exceptions and otherwise runs its default summary.
      // Explicitly cancel to avoid retrying a failed/no-progress strategy.
      if(!event.signal.aborted)ctx.ui.notify(`Compaction 중단: ${error instanceof Error?error.message:String(error)}`,'warning');
      return {cancel:true};
    }
  });
  pi.registerTool(defineTool({name:'ny_recall',label:'이전 원본 기록 조회',description:'Recover archived session entries after mechanical compaction. With entryId, return original text/tool calls (up to maxChars) and optionally one image by zero-based imageIndex. Without entryId, list the latest 20 matching message entries; query filters text, beforeEntryId pages backward. Retrieval is read-only and does not prove the current screen or completion.',parameters:Type.Object({entryId:Type.Optional(Type.String()),query:Type.Optional(Type.String()),beforeEntryId:Type.Optional(Type.String()),maxChars:Type.Optional(Type.Integer({minimum:100,maximum:30000})),imageIndex:Type.Optional(Type.Integer({minimum:0}))}),executionMode:'sequential',
    async execute(_id,p,_signal,_update,ctx){
      if(p.entryId){
        const entry=ctx.sessionManager.getEntry(p.entryId);if(!entry)throw new Error('Session entry not found');
        const raw=recalledText(entry),limit=p.maxChars??6000;
        const content:any[]=[{type:'text',text:raw.slice(0,limit)+(raw.length>limit?'\n[Text truncated; increase maxChars if needed]':'')}];
        if(p.imageIndex!==undefined){
          const images=entry.type==='message'&&'content' in entry.message&&Array.isArray(entry.message.content)?entry.message.content.filter((b:any)=>b.type==='image'):[];
          if(!images[p.imageIndex])throw new Error(`Image index unavailable; this entry contains ${images.length} images`);
          content.push(images[p.imageIndex]);
        }
        return {content,details:{entryId:entry.id}};
      }
      const branch=ctx.sessionManager.getBranch(),end=p.beforeEntryId?branch.findIndex(e=>e.id===p.beforeEntryId):branch.length;
      if(end<0)throw new Error('beforeEntryId not found');
      const entries=branch.slice(0,end).filter(e=>e.type==='message'||e.type==='compaction').map(e=>({entryId:e.id,text:recalledText(e)})).filter(e=>!p.query||e.text.toLowerCase().includes(p.query.toLowerCase())).slice(-20);
      return {content:[{type:'text' as const,text:JSON.stringify(entries.map(e=>({...e,text:e.text.slice(0,400)})))}],details:{count:entries.length}};
    }}));
}
