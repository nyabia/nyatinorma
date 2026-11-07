// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,resolve} from 'node:path';

// 실제 설정 로더를 격리된 작업 드라이브 fixture에서 사용하여 사용자 설정은 건드리지 않는다.
test('configured direct SELECT routes System One; native-provider fallback attempts it exactly once',async()=>{
  const root=resolve(import.meta.dirname,'..'),scratch=join(root,'.tmpdl');await mkdir(scratch,{recursive:true});
  const dir=await mkdtemp(join(scratch,'decision-config-'));
  try{
    await mkdir(join(dir,'src'));
    for(const file of ['ollama.ts','config.ts','host-context.ts','decision-backend.ts','selection.ts','types.ts'])await copyFile(join(root,'src',file),join(dir,'src',file));
    await writeFile(join(dir,'package.json'),JSON.stringify({type:'module'}));
    await writeFile(join(dir,'check.mjs'),`
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {select} from './src/ollama.ts';
import {selectForModel} from './src/selection.ts';
import {decisionBackendInfo} from './src/decision-backend.ts';
const configPath=new URL('./nyatinorma.json',import.meta.url);
const choices=[{id:'open',label:'Open'},{id:'think',label:'THINK'}];
const history=[{prompt:'old observation',image:'b2xk',answer:'B'}];
const fast={mode:'systemone',model:'d3:4b',url:'http://systemone.local',fallback:true};
const requests=[];let fail=false;
globalThis.fetch=async(input,init)=>{
  const url=String(input),body=JSON.parse(init.body),headers=new Headers(init.headers);requests.push({url,body,headers});
  if(url.endsWith('/v1/systemone'))return fail?new Response('unavailable',{status:503}):Response.json({answers:{selection:{type:'choice',choice:'open',probabilities:{open:.9,think:.1},confidence:.5}}});
  assert.ok(url.endsWith('/api/chat'));
  return Response.json({logprobs:[{token:'B',top_logprobs:[{token:'A',logprob:Math.log(.1)},{token:'B',logprob:Math.log(.9)}]}]});
};
const writeConfig=decision=>writeFile(configPath,JSON.stringify({model:'legacy-native',ollamaUrl:'http://native.local',decision}));
await writeConfig(undefined);
const baseline=await select('current',choices,undefined,'Y3VycmVudA==',undefined,history);
assert.equal(baseline.choice,'think');assert.equal(requests.length,1);assert.equal(requests[0].url,'http://native.local/api/chat');
assert.equal(requests[0].body.model,'legacy-native');assert.equal(decisionBackendInfo(baseline),undefined);
await writeConfig({mode:'legacy'});
await select('current',choices,undefined,'Y3VycmVudA==',undefined,history);
assert.equal(requests.length,2);assert.deepEqual(requests[1].body,requests[0].body);
await writeConfig(fast);
const success=await select('current',choices,undefined,'Y3VycmVudA==',undefined,history);
assert.equal(success.choice,'open');assert.equal(decisionBackendInfo(success).actual,'systemone');assert.equal(requests.length,3);
assert.equal(requests[2].url,'http://systemone.local/v1/systemone');assert.deepEqual(requests[2].body.images,['b2xk','Y3VycmVudA==']);
fail=true;
const connection={model:'connection-native',baseUrl:'http://connection.local',headers:{Authorization:'Bearer local-test'}};
const fallback=await select('current',choices,undefined,'Y3VycmVudA==',connection,history);
assert.equal(fallback.choice,'think');assert.equal(decisionBackendInfo(fallback).actual,'legacy');assert.equal(requests.length,5);
assert.equal(requests[3].url,'http://systemone.local/v1/systemone');assert.equal(requests[4].url,'http://connection.local/api/chat');
assert.equal(requests[4].body.model,'connection-native');assert.equal(requests[4].headers.get('Authorization'),'Bearer local-test');
assert.deepEqual(requests[4].body.messages[1].images,['b2xk']);assert.deepEqual(requests[4].body.messages.at(-1).images,['Y3VycmVudA==']);
const registry={getApiKeyAndHeaders:async()=>({ok:true,baseUrl:'http://provider.local',headers:{Authorization:'Bearer provider-test'}})};
const model={api:'nyatinorma-native-ollama',id:'active-provider-model',baseUrl:'http://unused.local'};
const provider=await selectForModel(registry,model,'current',choices,undefined,'Y3VycmVudA==',history);
assert.equal(provider.choice,'think');assert.equal(decisionBackendInfo(provider).fallback,true);assert.equal(requests.length,7);
assert.equal(requests[5].url,'http://systemone.local/v1/systemone');assert.equal(requests[6].url,'http://provider.local/api/chat');
assert.equal(requests[6].body.model,'active-provider-model');assert.equal(requests[6].headers.get('Authorization'),'Bearer provider-test');
await writeConfig({...fast,fallback:false});
await assert.rejects(select('current',choices),/System One http/);assert.equal(requests.length,8);
const abort=new AbortController();abort.abort(new Error('cancelled'));
await assert.rejects(select('current',choices,abort.signal),/cancelled/);assert.equal(requests.length,8);
`);
    await promisify(execFile)(process.execPath,['--import','tsx',join(dir,'check.mjs')],{cwd:root,env:{...process.env,NYATINORMA_DATA_DIR:join(dir,'data'),NYATINORMA_MODEL:'',NYATINORMA_OLLAMA_URL:''}});
  }finally{await rm(dir,{recursive:true,force:true});}
});
