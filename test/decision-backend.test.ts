// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {decisionBackendInfo,selectSystemOne,withDecisionBackend,type DecisionBackendConfig} from '../src/decision-backend.js';
import type {Decision} from '../src/types.js';

type WirePayload={
  state:{history:{prompt:string;answer:string;imageIndex?:number;image?:string}[];current:{prompt:string;imageIndex?:number;image?:string};imageOrder?:string};
  questions:{selection:{type:string;criteria:Record<string,string>}};
  images?:string[];assets?:Record<string,unknown>;[key:string]:unknown;
};
const choices=[{id:'open',label:'Open',box:{x:.1,y:.2,width:.3,height:.4}},{id:'think',label:'THINK'}];
const backend:DecisionBackendConfig={mode:'systemone',model:'d3:4b',url:'http://127.0.0.1:11434'};
const answer={answers:{selection:{type:'choice',choice:'open',probabilities:{open:.8,think:.2},confidence:0}}};
const legacyResult:Decision={choice:'think',probabilities:{open:.1,think:.9},margin:.8,legalMass:.7,truncated:false,reason:'legacy',elapsedMs:2,metrics:{provider:'original'}};

test('Ollama System One sends ordered top-level images and history as data, not chat',async t=>{
  let body!:WirePayload,requestUrl='';
  t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init:RequestInit={})=>{requestUrl=String(input);body=JSON.parse(String(init.body));return Response.json(answer);});
  const result=await selectSystemOne('current',choices,undefined,'Y3VycmVudA==',{...backend,url:'http://127.0.0.1:11434/v1/'},[
    {prompt:'old prompt',answer:'B',image:'b2xk'},
    {prompt:'text only',answer:'A'},
  ]);
  assert.equal(requestUrl,'http://127.0.0.1:11434/v1/systemone');
  assert.deepEqual(body.images,['b2xk','Y3VycmVudA==']);
  assert.deepEqual(body.state.history,[{prompt:'old prompt',imageIndex:0,answer:'B'},{prompt:'text only',answer:'A'}]);
  assert.deepEqual(body.state.current,{prompt:'current',imageIndex:1});
  assert.equal(body.questions.selection.type,'choice');assert.match(body.questions.selection.criteria.open,/box=/);
  assert.equal(body.messages,undefined);
  assert.equal(result.choice,'open');assert.deepEqual(result.probabilities,{open:.8,think:.2});
  assert.equal(decisionBackendInfo(result)?.actual,'systemone');
});

test('Jev images use unique referenced assets at the right history/current locations',async t=>{
  let body!:WirePayload,headers:Headers|undefined;
  t.mock.method(globalThis,'fetch',async(_input:Parameters<typeof fetch>[0],init:RequestInit={})=>{assert.equal(typeof init.body,'string');body=JSON.parse(String(init.body));headers=new Headers(init.headers);return Response.json(answer);});
  await selectSystemOne('current',choices,undefined,'Y3VycmVudA==',{...backend,wire:'typesafe',url:'https://api.typesafe.ai/v1/systemone'},[{prompt:'old',answer:'B',image:'b2xk'}]);
  assert.equal(headers!.get('TypeSafe-Danger-Zone-Images'),'true');assert.equal(body.images,undefined);
  const old=body.state.history[0].image,current=body.state.current.image;
  assert.ok(old);assert.ok(current);assert.ok(body.assets);assert.notEqual(old,current);assert.equal(Object.keys(body.assets).length,2);
  assert.deepEqual(body.assets[old],{type:'image',format:'png',data_base64:'b2xk'});
  assert.deepEqual(body.assets[current],{type:'image',format:'png',data_base64:'Y3VycmVudA=='});
  assert.equal(body.state.history[0].answer,'B');assert.equal(body.state.current.prompt,'current');
});

test('an unknown provider choice rejects instead of becoming an input target',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({answers:{selection:{type:'choice',choice:'unknown',probabilities:{open:.8,think:.2},confidence:1}}}));
  await assert.rejects(selectSystemOne('state',choices,undefined,undefined,backend),/invalid_response/);
});

test('provider failure falls back once and preserves the legacy result with provenance',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>new Response('unavailable',{status:503}));
  const result=await withDecisionBackend('state',choices,async()=>{calls++;return legacyResult;},undefined,undefined,backend);
  assert.equal(calls,1);assert.equal(result.choice,'think');
  assert.ok(result.metrics&&typeof result.metrics==='object'&&'provider' in result.metrics);assert.equal(result.metrics.provider,'original');
  const info=decisionBackendInfo(result);
  assert.equal(info?.actual,'legacy');assert.equal(info?.fallback,true);assert.equal(info?.errorCode,'http');
});

test('user cancellation never falls back to another provider',async t=>{
  let legacyCalls=0;
  t.mock.method(globalThis,'fetch',async(_input:Parameters<typeof fetch>[0],init:RequestInit={})=>{
    assert.ok(init.signal);init.signal.throwIfAborted();
    await once(init.signal,'abort');throw init.signal.reason;
  });
  const controller=new AbortController();
  const pending=withDecisionBackend('state',choices,async()=>{legacyCalls++;return legacyResult;},controller.signal,undefined,backend);
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending,/cancelled/);assert.equal(legacyCalls,0);
});

