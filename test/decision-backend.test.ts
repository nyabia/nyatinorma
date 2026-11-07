// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {selectLegacyOllama} from '../src/ollama.js';
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
  let body!:WirePayload,requestUrl='',headers:Headers|undefined;
  t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init:RequestInit={})=>{requestUrl=String(input);assert.equal(typeof init.body,'string');body=JSON.parse(String(init.body));headers=new Headers(init.headers);return Response.json(answer);});
  const result=await selectSystemOne('current',choices,undefined,'Y3VycmVudA==',{...backend,url:'http://127.0.0.1:11434/v1/'},[
    {prompt:'old prompt',answer:'B',image:'b2xk'},
    {prompt:'text only',answer:'A'},
  ]);
  assert.equal(requestUrl,'http://127.0.0.1:11434/v1/systemone');
  assert.deepEqual(body.images,['b2xk','Y3VycmVudA==']);
  assert.deepEqual(body.state.history,[{prompt:'old prompt',imageIndex:0,answer:'B'},{prompt:'text only',answer:'A'}]);
  assert.deepEqual(body.state.current,{prompt:'current',imageIndex:1});
  assert.match(body.state.imageOrder??'',/zero-based/);
  assert.equal(body.questions.selection.type,'choice');assert.match(body.questions.selection.criteria.open,/box=/);
  assert.equal(body.messages,undefined);assert.equal(body.assets,undefined);assert.equal(body.options,undefined);assert.equal(body.logprobs,undefined);
  assert.equal(headers!.get('TypeSafe-Danger-Zone-Images'),null);
  assert.equal(result.choice,'open');assert.equal(result.margin,.6000000000000001);assert.equal(result.legalMass,1);assert.equal(result.truncated,false);
  assert.match(result.reason,/uncalibrated/);assert.equal(decisionBackendInfo(result)?.actual,'systemone');
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

test('complete rounded probabilities normalize; confidence never controls approval',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({answers:{selection:{type:'choice',choice:'open',probabilities:{open:.8000,think:.1999},confidence:0}}}));
  const result=await selectSystemOne('state',choices,undefined,undefined,backend);
  assert.equal(result.choice,'open');assert.equal(result.probabilities.open,.8/.9999);assert.equal(result.legalMass,.9999);
});

test('unsupported or malformed answers reject instead of inventing probabilities',async t=>{
  let raw:unknown;
  t.mock.method(globalThis,'fetch',async()=>Response.json(raw));
  const invalid=[
    {},{answers:{selection:{type:'noul',noul:1}}},
    {type:'choice',choice:'open',probabilities:{open:.8}},
    {type:'choice',choice:'open',probabilities:{open:.8,think:.1,unknown:.1}},
    {type:'choice',choice:'unknown',probabilities:{open:.8,think:.2}},
    {type:'choice',choice:'think',probabilities:{open:.8,think:.2}},
    {type:'choice',choice:'open',probabilities:{open:1,think:-.1}},
    {type:'choice',choice:'open',probabilities:{open:'0.8',think:.2}},
    {type:'choice',choice:'open',probabilities:{open:0,think:0}},
    {type:'choice',choice:'open',confidence:1},
    {type:'choice',choice:'open',probabilities:{open:.8,think:.2},confidence:2},
    {type:'choice',choice:'open',probabilities:{open:.8,think:.2},confidence:undefined},
  ];
  for(const value of invalid){raw=('type' in value)?{answers:{selection:{confidence:1,...value}}}:value;await assert.rejects(selectSystemOne('state',choices,undefined,undefined,backend),/invalid_response/);}
});

test('provider, transport, JSON and answer failures fall back once with sanitized provenance',async t=>{
  let mode='http',calls=0;
  const secret='Bearer never-print-this';process.env.NYATINORMA_TEST_DECISION_HEADER=secret;
  t.mock.method(globalThis,'fetch',async(_input:Parameters<typeof fetch>[0],init:RequestInit={})=>{
    assert.equal(new Headers(init.headers).get('Authorization'),secret);
    if(mode==='http')return new Response(secret,{status:503});
    if(mode==='transport')throw new Error(secret);
    if(mode==='json')return new Response(secret,{status:200});
    return Response.json({answers:{selection:{type:'choice',choice:'open',confidence:1}}});
  });
  try{
    for(const [failure,code] of [['http','http'],['transport','transport'],['json','invalid_response'],['answer','invalid_response']]){
      mode=failure;
      const result=await withDecisionBackend('state',choices,async()=>{calls++;return legacyResult;},undefined,undefined,{...backend,headersFromEnv:{Authorization:'NYATINORMA_TEST_DECISION_HEADER'}});
      assert.equal(result.choice,'think');assert.ok(result.metrics&&typeof result.metrics==='object'&&'provider' in result.metrics);assert.equal(result.metrics.provider,'original');
      const info=decisionBackendInfo(result);assert.equal(info?.actual,'legacy');assert.equal(info?.fallback,true);assert.equal(info?.errorCode,code);
      assert.ok(!JSON.stringify(result).includes(secret));
    }
    assert.equal(calls,4);
    mode='transport';await assert.rejects(withDecisionBackend('state',choices,async()=>{calls++;return legacyResult;},undefined,undefined,{...backend,fallback:false,headersFromEnv:{Authorization:'NYATINORMA_TEST_DECISION_HEADER'}}),error=>error instanceof Error&&error.message==='System One transport');
    assert.equal(calls,4);
  }finally{delete process.env.NYATINORMA_TEST_DECISION_HEADER;}
});

test('missing credentials fail safely and never become an HTTP header value',async t=>{
  let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;return Response.json(answer);});
  delete process.env.NYATINORMA_TEST_MISSING_HEADER;
  await assert.rejects(selectSystemOne('state',choices,undefined,undefined,{...backend,headersFromEnv:{Authorization:'NYATINORMA_TEST_MISSING_HEADER'}}),/configuration/);
  assert.equal(requests,0);
});

test('request timeout falls back but user cancellation never falls back',async t=>{
  let legacyCalls=0,requests=0,clock=new AbortController();
  t.mock.method(AbortSignal,'timeout',()=>clock.signal);
  t.mock.method(globalThis,'fetch',async(_input:Parameters<typeof fetch>[0],init:RequestInit={})=>{
    requests++;assert.ok(init.signal);init.signal.throwIfAborted();
    await once(init.signal,'abort');throw init.signal.reason;
  });
  const legacy=async()=>{legacyCalls++;return legacyResult;};
  const timed=withDecisionBackend('state',choices,legacy,undefined,undefined,{...backend,timeoutMs:5});
  clock.abort(new DOMException('request timeout','TimeoutError'));
  const timeout=await timed;
  assert.equal(decisionBackendInfo(timeout)?.errorCode,'timeout');assert.equal(legacyCalls,1);
  clock=new AbortController();
  const before=new AbortController();before.abort(new Error('cancel before'));
  await assert.rejects(withDecisionBackend('state',choices,legacy,before.signal,undefined,backend),/cancel before/);assert.equal(requests,1);
  const during=new AbortController();
  const pending=withDecisionBackend('state',choices,legacy,during.signal,undefined,backend);during.abort(new Error('cancel during'));
  await assert.rejects(pending,/cancel during/);assert.equal(legacyCalls,1);
});

test('legacy mode/unconfigured backend preserve the original SELECT wire and result',async t=>{
  const requests:{url:string;body:unknown}[]=[];
  t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init:RequestInit={})=>{
    assert.equal(typeof init.body,'string');requests.push({url:String(input),body:JSON.parse(String(init.body))});
    return Response.json({logprobs:[{token:'B',top_logprobs:[{token:'A',logprob:Math.log(.2)},{token:'B',logprob:Math.log(.8)}]}]});
  });
  const legacy=()=>selectLegacyOllama('original state',choices,undefined,'aW1hZ2U=',{model:'original-model',baseUrl:'http://original.local'});
  const direct=await legacy(),unconfigured=await withDecisionBackend('original state',choices,legacy),explicit=await withDecisionBackend('original state',choices,legacy,undefined,undefined,{mode:'legacy',url:'http://must-not-be-used.local'});
  assert.deepEqual(requests[1],requests[0]);assert.deepEqual(requests[2],requests[0]);assert.equal(requests[0].url,'http://original.local/api/chat');
  assert.equal(unconfigured.choice,direct.choice);assert.equal(explicit.reason,direct.reason);assert.equal(decisionBackendInfo(unconfigured),undefined);assert.equal(decisionBackendInfo(explicit),undefined);
});

test('provenance reader rejects untrusted metrics shapes',()=>{
  for(const value of [null,[],{decisionBackend:{requested:'systemone',actual:'legacy',wire:'ollama',fallback:false,attemptMs:1}},{decisionBackend:{requested:'systemone',actual:'systemone',wire:'ollama',fallback:false,attemptMs:NaN}}])assert.equal(decisionBackendInfo({...legacyResult,metrics:value}),undefined);
});
