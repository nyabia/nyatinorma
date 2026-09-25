// SPDX-License-Identifier: MIT OR Apache-2.0
import {buildSessionProjection,buildSessionContext,estimateTokens,type CompactionResult,type SessionBeforeCompactEvent} from '@earendil-works/pi-coding-agent';
import type {Model} from '@earendil-works/pi-ai';

type Record={entryId:string;role:string;text:string;protected:boolean};
export type PruneDetails={strategy:'prune-v1'|'trim-v1';records:Record[];droppedRecords:number};
export type Boundary=Pick<SessionBeforeCompactEvent,'preparation'|'branchEntries'>;
const textOf=(content:any)=>typeof content==='string'?content:Array.isArray(content)?content.filter(c=>c.type==='text').map(c=>c.text).join('\n'):'';
const header='Mechanically pruned history, not an AI-written summary. Old tool outputs/images were elided at this compaction boundary. User text below is verbatim and chronological; later corrections take precedence. Omission does not prove completion. Original entries remain in the saved session: use ny_recall(entryId), or query its index. Saved plan, checkpoints and app knowledge are supplied separately.';
const render=(records:Record[],dropped:number)=>header+`\nEarlier non-user records omitted: ${dropped}.\n\n`+records.map(r=>`[${r.role}; entryId=${r.entryId}]\n${r.text}`).join('\n\n');
const tokens=(text:string)=>estimateTokens({role:'user',timestamp:0,content:text});

/** Pure, deterministic adapter for pi's compaction hook. No inference or file edits.
 * Keep pi's valid recent-message cut point, including intact tool-call/result pairs.
 * Only a committed compaction changes the prefix; normal requests do not prune.
 */
export function pruneCompaction(event:Boundary):CompactionResult<PruneDetails>{
  const {preparation:p,branchEntries}=event;
  const projected=buildSessionProjection(branchEntries).entries;
  const cut=projected.findIndex(e=>e.sourceEntry.id===p.firstKeptEntryId);
  if(cut<=0)throw new Error('No older history can be pruned at this boundary.');
  const records:Record[]=[];let dropped=0;
  for(const entry of projected.slice(0,cut)){
    if(!entry.messages.length)continue;
    const source=entry.sourceEntry;
    if(source.type==='compaction'){
      const details=source.details as PruneDetails|undefined;
      if(details?.strategy==='prune-v1'||details?.strategy==='trim-v1'){
        records.push(...details.records.map(r=>({...r})));dropped+=details.droppedRecords;
      }else records.push({entryId:source.id,role:'previous summary',text:source.summary,protected:true});
      continue;
    }
    for(const message of entry.messages){
      const m=message as any;
      if(m.role==='system')continue;
      let text=textOf(m.content),protect=m.role==='user';
      if(m.role==='assistant'){
        const calls=m.content.filter((c:any)=>c.type==='toolCall').map((c:any)=>({id:c.id,name:c.name,arguments:c.arguments}));
        if(calls.length)text+='\nTool calls: '+JSON.stringify(calls);
      }else if(m.role==='toolResult'){
        const hasImages=m.content.some((c:any)=>c.type==='image');
        const note=`Tool ${m.toolName}; callId=${m.toolCallId}; isError=${Boolean(m.isError)}.`;
        text=note+'\n'+(m.isError?text.slice(0,2000)+(text.length>2000?'\n[Remaining error text archived]':''):!hasImages&&text.length<=600?text:'[Tool output and images elided; retrieve this entry when needed]');
      }else if(!text)text=m.summary??'';
      if(m.role==='user'&&Array.isArray(m.content)&&m.content.some((c:any)=>c.type==='image'))text+='\n[User image attachments archived in this entry; retrieve with ny_recall imageIndex when needed.]';
      if(text)records.push({entryId:source.id,role:m.role,text,protected:protect});
    }
  }
  return {summary:render(records,dropped),firstKeptEntryId:p.firstKeptEntryId,tokensBefore:p.tokensBefore,details:{strategy:'prune-v1',records,droppedRecords:dropped}};
}

/** Estimate the entire proposed projection, including pi's retained raw tail. */
export function contextTokens(event:Boundary,result?:CompactionResult){
  const entries=result?[...event.branchEntries,{...result,type:'compaction' as const,id:'ny-compaction-estimate',parentId:event.branchEntries.at(-1)?.id??null,timestamp:new Date(0).toISOString()}]:event.branchEntries;
  return buildSessionContext(entries).messages.reduce((sum,m)=>sum+estimateTokens(m),0);
}

/** Target is below pi's trigger, leaving headroom for schemas, images and estimates. */
export function recoveryTarget(event:Boundary,model:Model<any>){
  return Math.floor(Math.max(0,model.contextWindow-event.preparation.settings.reserveTokens)*0.7);
}

export function trimCompaction(event:Boundary,candidate:CompactionResult<PruneDetails>,target:number):CompactionResult<PruneDetails>{
  const records=candidate.details!.records.map(r=>({...r}));
  let dropped=candidate.details!.droppedRecords;
  const tail=contextTokens(event,{...candidate,summary:''});
  const budget=target-tail;
  let summary=render(records,dropped);
  while(tokens(summary)>budget){
    const index=records.findIndex(r=>!r.protected);
    if(index<0)throw new Error('사용자 지시와 이전 요약만으로 정리 예산을 초과했습니다. 지시를 자동 삭제하지 않았습니다. 더 큰 컨텍스트 또는 새 대화가 필요합니다.');
    records.splice(index,1);dropped++;summary=render(records,dropped);
  }
  return {...candidate,summary,details:{strategy:'trim-v1',records,droppedRecords:dropped}};
}

export function recalledText(entry:any){
  const m=entry.message;
  if(!m)return JSON.stringify(entry.type==='compaction'?{id:entry.id,type:entry.type,summary:entry.summary}:{id:entry.id,type:entry.type});
  return JSON.stringify({id:entry.id,role:m.role,toolName:m.toolName,toolCallId:m.toolCallId,isError:m.isError,text:textOf(m.content),calls:Array.isArray(m.content)?m.content.filter((c:any)=>c.type==='toolCall'):undefined});
}
