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
  const url=String(input),body=JSON.parse(init.body);requests.push({url,body});
  if(url.endsWith('/v1/systemone'))return fail?new Response('unavailable',{status:503}):Response.json({answers:{selection:{type:'choice',choice:'open',probabilities:{open:.9,think:.1},confidence:.5}}});
  assert.ok(url.endsWith('/api/chat'));
  return Response.json({logprobs:[{token:'B',top_logprobs:[{token:'A',logprob:Math.log(.1)},{token:'B',logprob:Math.log(.9)}]}]});
};
const writeConfig=decision=>writeFile(configPath,JSON.stringify({model:'legacy-native',ollamaUrl:'http://native.local',decision}));
await writeConfig(fast);
const success=await select('current',choices,undefined,'Y3VycmVudA==',undefined,history);
assert.equal(success.choice,'open');assert.equal(decisionBackendInfo(success).actual,'systemone');assert.equal(requests.length,1);
assert.equal(requests[0].url,'http://systemone.local/v1/systemone');assert.deepEqual(requests[0].body.images,['b2xk','Y3VycmVudA==']);
fail=true;
const registry={getApiKeyAndHeaders:async()=>({ok:true,baseUrl:'http://provider.local'})};
const model={api:'nyatinorma-native-ollama',id:'active-provider-model',baseUrl:'http://unused.local'};
const provider=await selectForModel(registry,model,'current',choices,undefined,'Y3VycmVudA==',history);
assert.equal(provider.choice,'think');assert.equal(decisionBackendInfo(provider).fallback,true);assert.equal(requests.length,3);
assert.equal(requests[1].url,'http://systemone.local/v1/systemone');assert.equal(requests[2].url,'http://provider.local/api/chat');
assert.equal(requests[2].body.model,'active-provider-model');
`);
    await promisify(execFile)(process.execPath,['--import','tsx',join(dir,'check.mjs')],{cwd:root,env:{...process.env,NYATINORMA_DATA_DIR:join(dir,'data'),NYATINORMA_MODEL:'',NYATINORMA_OLLAMA_URL:''}});
  }finally{await rm(dir,{recursive:true,force:true});}
});
