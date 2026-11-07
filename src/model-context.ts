// SPDX-License-Identifier: MIT OR Apache-2.0
import type {Model} from '@earendil-works/pi-ai';
import type {ModelRegistry} from '@earendil-works/pi-coding-agent';

/** OpenAI 호환 서버(SGLang/vLLM)의 런타임 한도를 현재 모델과 레지스트리에 적용한다.
 * 유효한 서버 한도가 없으면 등록값을 유지하며 등록 파일이나 서버 설정은 바꾸지 않는다.
 */
export function createContextLimitCheck(fetcher:typeof fetch=fetch){
  const cache=new Map<string,{at:number;limit?:number}>();
  return async(model:Model<any>,registry:Pick<ModelRegistry,'getApiKeyAndHeaders'|'find'>)=>{
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
        const limit=Array.isArray(body?.data)?body.data.find((m:any)=>m?.id===model.id)?.max_model_len:undefined;
        entry={at:Date.now(),limit:Number.isSafeInteger(limit)&&limit>0?limit:undefined};cache.set(key,entry);
      }
      if(entry.limit!==undefined){
        const previous=model.contextWindow,registered=registry.find(model.provider,model.id);
        model.contextWindow=entry.limit;
        if(registered)registered.contextWindow=entry.limit;
        if(previous!==entry.limit)return {previous,current:entry.limit};
      }
    }catch{/* 선택적 메타데이터 조회 실패는 미지원 서버의 사용을 막지 않는다. */}
  };
}
