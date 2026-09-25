// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import type {Model} from '@earendil-works/pi-ai';
import {createContextLimitCheck} from '../src/model-context.js';

const model=():Model<any>=>({id:'vision-model',name:'Vision',api:'openai-completions',provider:'custom',baseUrl:'http://unused.invalid/v1',input:['text','image'],reasoning:true,contextWindow:131072,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}});
const registry={getApiKeyAndHeaders:async()=>({ok:true as const,apiKey:'test',baseUrl:'http://local.invalid/proxy/v1/',headers:{'X-Custom':'present'}})};

test('server runtime cap uses resolved provider auth and limits current context without raising user caps',async()=>{
 let calls=0;
 const check=createContextLimitCheck(async(url,init)=>{
  calls++;assert.equal(url,'http://local.invalid/proxy/v1/models');
  assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer test');
  assert.equal(new Headers(init?.headers).get('X-Custom'),'present');
  return Response.json({data:[{id:'other',max_model_len:1024},{id:'vision-model',max_model_len:65536}]});
 });
 const m=model();assert.deepEqual(await check(m,registry),{previous:131072,current:65536});assert.equal(m.contextWindow,65536);
 const capped={...model(),contextWindow:32768};assert.equal(await check(capped,registry),undefined);assert.equal(capped.contextWindow,32768);assert.equal(calls,1);
});

test('absent, invalid or unavailable metadata preserves registration; other API families are untouched',async()=>{
 for(const value of [undefined,-1,0,'65536',1.5]){
  const m=model();await createContextLimitCheck(async()=>Response.json({data:[{id:m.id,max_model_len:value}]}))(m,registry);assert.equal(m.contextWindow,131072);
 }
 const m=model();await createContextLimitCheck(async()=>{throw new Error('offline');})(m,registry);assert.equal(m.contextWindow,131072);
 let otherCalls=0;const other={...model(),api:'nyatinorma-native-ollama'};await createContextLimitCheck(async()=>{otherCalls++;return Response.json({});})(other,registry);assert.equal(otherCalls,0);
});
