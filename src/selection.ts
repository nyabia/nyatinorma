// SPDX-License-Identifier: MIT OR Apache-2.0
import {normalizeContext,type Model} from '@earendil-works/pi-ai';
import type {ModelRegistry} from '@earendil-works/pi-coding-agent';
import {config} from './config.js';
import {select,decodeDecision,selectionPrompt} from './ollama.js';

type Choices=Parameters<typeof select>[1];
// The active pi provider owns credentials, endpoint, compatibility and streaming.
// Only the extra logprob request/response handling belongs to SELECT.
export async function selectForModel(registry:ModelRegistry,model:Model<any>|undefined,state:string,choices:Choices,signal?:AbortSignal,image?:string){
  if(!model)throw new Error('먼저 /model에서 모델을 선택하세요.');
  if(model.api==='nyatinorma-native-ollama'){
    const auth=await registry.getApiKeyAndHeaders(model);if(!auth.ok)throw new Error(auth.error);
    return select(state,choices,signal,image,{model:model.id,baseUrl:auth.baseUrl??model.baseUrl,headers:auth.headers});
  }
  if(model.api!=='openai-completions')throw new Error('이 provider는 SELECT logprobs 경로가 지원되지 않습니다. 현재 모델의 THINK와 ny_act는 사용할 수 있습니다. 다른 서버로 자동 전환하지 않습니다.');
  if(choices.length<2||choices.length>12)throw new Error('SELECT requires 2–12 choices including THINK.');
  const start=performance.now(),c=await config(),timeout=AbortSignal.timeout(c.ollamaTimeoutSeconds*1000);
  const combined=signal?AbortSignal.any([signal,timeout]):timeout;
  const captures:Promise<string>[]=[];
  const prompt=selectionPrompt(state,choices);
  const result=await registry.streamSimple(model,normalizeContext({systemPrompt:prompt.system,messages:[{role:'user',timestamp:Date.now(),content:[{type:'text',text:prompt.user},...(image?[{type:'image' as const,data:image,mimeType:'image/png'}]:[])]}]}),{
    signal:combined,maxTokens:1,temperature:1,
    onPayload:payload=>({...payload as object,logprobs:true,top_logprobs:20}),
    fetch:async(input,init)=>{const response=await fetch(input,init);const copy=response.clone().text();void copy.catch(()=>{});captures.push(copy);return response;},
  }).result();
  if(result.stopReason==='error'||result.stopReason==='aborted')throw new Error(result.errorMessage??'SELECT provider request failed');
  const body=await captures.at(-1);const rows:any[]=[];
  for(const line of (body??'').split('\n')){
    if(!line.startsWith('data:'))continue;const value=line.slice(5).trim();if(!value||value==='[DONE]')continue;
    const chunk=JSON.parse(value);rows.push(...(chunk.choices?.[0]?.logprobs?.content??[]));
  }
  return {...decodeDecision({logprobs:rows},choices.map(v=>v.id)),elapsedMs:performance.now()-start,metrics:{usage:result.usage,provider:model.provider,model:model.id}};
}
