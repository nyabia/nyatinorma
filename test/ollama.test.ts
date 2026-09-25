// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {select,selectionPrompt} from '../src/ollama.js';

test('SELECT sends one-token non-thinking requests to the existing endpoint, without changing model residency',async()=>{
  let payload:any;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;payload=JSON.parse(body);
    assert.equal(req.url,'/api/chat');res.setHeader('content-type','application/json');
    res.end(JSON.stringify({logprobs:[{token:'B',top_logprobs:[{token:'A',logprob:Math.log(.1)},{token:'B',logprob:Math.log(.85)},{token:'C',logprob:Math.log(.05)}]}],total_duration:100000000,prompt_eval_duration:50000000,eval_duration:10000000}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const oldModel=process.env.NYATINORMA_MODEL;process.env.NYATINORMA_MODEL='test-vision-model';const old=process.env.NYATINORMA_OLLAMA_URL;process.env.NYATINORMA_OLLAMA_URL=`http://127.0.0.1:${(server.address() as any).port}`;
  try{
    const result=await select('state',[{id:'a',label:'first'},{id:'b',label:'second'},{id:'think',label:'THINK'}],undefined,'screen-image-base64');
    assert.deepEqual(payload.messages[1].images,['screen-image-base64']);
    assert.equal(result.choice,'b');assert.equal(payload.think,false);assert.equal(payload.logprobs,true);assert.equal(payload.options.num_predict,1);
    const first=structuredClone(payload),choices=[{id:'a',label:'first'},{id:'b',label:'second'},{id:'think',label:'THINK'}];
    const history=[{prompt:selectionPrompt('state',choices).user,image:'screen-image-base64',answer:'B'}];
    await select('zoom',choices,undefined,'zoom-image',undefined,history);
    assert.deepEqual(payload.messages.slice(0,2),first.messages);
    assert.deepEqual(payload.messages[2],{role:'assistant',content:'B'});
    await select('state',choices,undefined,'screen-image-base64');
    assert.deepEqual(payload.messages,first.messages);
    assert.equal(payload.model,'test-vision-model');assert.equal(payload.keep_alive,undefined);assert.equal(payload.options.num_ctx,undefined);
  }finally{if(oldModel===undefined)delete process.env.NYATINORMA_MODEL;else process.env.NYATINORMA_MODEL=oldModel;if(old===undefined)delete process.env.NYATINORMA_OLLAMA_URL;else process.env.NYATINORMA_OLLAMA_URL=old;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
