// SPDX-License-Identifier: MIT OR Apache-2.0
import type {Model} from '@earendil-works/pi-ai';
import type {ModelRegistry} from '@earendil-works/pi-coding-agent';

/** Read runtime limits advertised by OpenAI-compatible servers (SGLang/vLLM).
 * Never raise a user-set cap, rewrite model registration or change the server.
 * Missing metadata is not evidence of a different limit.
 */
export function createContextLimitCheck(fetcher:typeof fetch=fetch){
  const cache=new Map<string,{at:number;limit?:number}>();
  return async(model:Model<any>,registry:Pick<ModelRegistry,'getApiKeyAndHeaders'>)=>{
    if(model.api!=='openai-completions')return;
    try{
      const auth=await registry.getApiKeyAndHeaders(model);if(!auth.ok)return;
      const url=(auth.baseUrl??model.baseUrl).replace(/\/$/,'')+'/models',key=url+'\n'+model.id;
      let entry=cache.get(key);
      if(!entry||Date.now()-entry.at>60000){
        const headers=new Headers();
        for(const [name,value] of Object.entries(auth.headers??{}))if(value!=null)headers.set(name,value);
        if(auth.apiKey&&!headers.has('Authorization'))headers.set('Authorization','Bearer '+auth.apiKey);
        const response=await fetcher(url,{headers,signal:AbortSignal.timeout(5000),redirect:'error'});
        const body=response.ok?await response.json() as any:undefined;
        const limit=Array.isArray(body?.data)?body.data.find((m:any)=>m.id===model.id)?.max_model_len:undefined;
        entry={at:Date.now(),limit:Number.isSafeInteger(limit)&&limit>0?limit:undefined};cache.set(key,entry);
      }
      if(entry.limit!==undefined&&entry.limit<model.contextWindow){
        const previous=model.contextWindow;model.contextWindow=entry.limit;
        return {previous,current:entry.limit};
      }
    }catch{/* Optional metadata lookup must not block providers without discovery. */}
  };
}
