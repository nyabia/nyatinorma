// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import type {Model} from '@earendil-works/pi-ai';
import {createContextLimitCheck} from '../src/model-context.js';

const model=():Model<any>=>({id:'vision-model',name:'Vision',api:'openai-completions',provider:'custom',baseUrl:'http://unused.invalid/v1',input:['text','image'],reasoning:true,contextWindow:131072,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}});
const registry=(registered?:Model<any>)=>({
 getApiKeyAndHeaders:async()=>({ok:true as const,apiKey:'test',baseUrl:'http://local.invalid/proxy/v1/'}),
 find:(provider:string,id:string)=>registered?.provider===provider&&registered.id===id?registered:undefined,
});

test('server runtime context overrides configured limits upward and downward',async()=>{
 const check=createContextLimitCheck(async()=>Response.json({data:[{id:'vision-model',max_model_len:409600}]}));
 const m={...model(),contextWindow:65536},registered={...model(),contextWindow:65536},r=registry(registered);
 assert.deepEqual(await check(m,r),{previous:65536,current:409600});
 assert.equal(m.contextWindow,409600);assert.equal(registered.contextWindow,409600);
 const larger={...model(),contextWindow:524288};registered.contextWindow=524288;
 assert.deepEqual(await check(larger,r),{previous:524288,current:409600});
 assert.equal(larger.contextWindow,409600);assert.equal(registered.contextWindow,409600);
});

