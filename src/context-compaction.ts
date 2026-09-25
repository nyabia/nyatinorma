// SPDX-License-Identifier: MIT OR Apache-2.0
import {buildSessionContext,estimateTokens,shouldCompact,type SessionEntry} from '@earendil-works/pi-coding-agent';
import type {Model} from '@earendil-works/pi-ai';

/** Recorded usage can belong to another model or an older payload projection.
 * Re-estimate at session/model boundaries, then defer summarization to pi itself.
 * Do not rewrite the prefix on individual requests.
 */
export function boundaryCompaction(entries:readonly SessionEntry[],model:Model<any>,settings:{enabled:boolean;reserveTokens:number;keepRecentTokens:number}){
  if(!settings.enabled)return;
  const messages=buildSessionContext([...entries]).messages;
  const last=messages.findLast(m=>m.role==='assistant'&&m.stopReason!=='error'&&m.stopReason!=='aborted');
  if(!last)return;
  const tokens=messages.reduce((sum,message)=>sum+estimateTokens(message),0);
  if(shouldCompact(tokens,model.contextWindow,settings))return {estimatedTokens:tokens,contextWindow:model.contextWindow};
}
