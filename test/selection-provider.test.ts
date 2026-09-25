// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ModelRuntime,ModelRegistry} from '@earendil-works/pi-coding-agent';
import {selectForModel} from '../src/selection.js';

test('SELECT uses the active standard pi provider, auth, image format and thinking compatibility; missing logprobs abstain',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-provider-'));let missing=false;const requests:any[]=[];
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'different-model',max_model_len:16384}]}));return;}
    let body='';for await(const chunk of req)body+=chunk;const p=JSON.parse(body);requests.push(p);
    assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer test-key');assert.equal(req.headers['x-test'],'provider-header');
    res.setHeader('content-type','text/event-stream');
    const logprobs=missing?undefined:{content:[{token:'B',logprob:Math.log(.8),top_logprobs:[{token:'A',logprob:Math.log(.1)},{token:'B',logprob:Math.log(.8)},{token:'C',logprob:Math.log(.1)}]}]};
    res.end(`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'B'},finish_reason:null,logprobs}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'length'}],usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const modelsPath=join(dir,'models.json'),baseUrl=`http://127.0.0.1:${(server.address() as any).port}/v1`;
  await writeFile(modelsPath,JSON.stringify({providers:{custom:{baseUrl,api:'openai-completions',apiKey:'test-key',headers:{'X-Test':'provider-header'},models:[{id:'different-model',reasoning:true,input:['text','image'],contextWindow:32768,maxTokens:4096,compat:{supportsStore:false,supportsDeveloperRole:false,maxTokensField:'max_tokens',thinkingFormat:'qwen-chat-template'}}]}}}));
  try{
    const runtime=await ModelRuntime.create({modelsPath,authPath:join(dir,'auth.json'),modelsStorePath:join(dir,'catalog.json'),allowModelNetwork:false});const registry=new ModelRegistry(runtime),model=registry.find('custom','different-model');assert.ok(model,registry.getError());
    await mkdir(join(dir,'pi'));await writeFile(join(dir,'pi','models.json'),await (await import('node:fs/promises')).readFile(modelsPath));await writeFile(join(dir,'pi','settings.json'),JSON.stringify({defaultProvider:'custom',defaultModel:'different-model',quietStartup:true}));
    const child=spawn(process.execPath,['--import','tsx','src/cli.ts','tui','--mode','rpc'],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,NYATINORMA_DATA_DIR:dir,NYATINORMA_MODEL:'old-native-default'},stdio:'pipe'});
    try{
      const state=await new Promise<any>((resolve,reject)=>{let buffer='';const timer=setTimeout(()=>reject(new Error('Startup state timeout')),8000);child.once('error',reject);child.stdout.on('data',chunk=>{buffer+=chunk;for(const line of buffer.split('\n')){try{const event=JSON.parse(line);if(event.id==='state'){clearTimeout(timer);resolve(event);}}catch{}}});child.stdin.write(JSON.stringify({id:'state',type:'get_state'})+'\n');});
      assert.equal(state.success,true);assert.equal(state.data.model.provider,'custom');assert.equal(state.data.model.id,'different-model');assert.equal(state.data.model.contextWindow,16384);
    }finally{child.kill('SIGTERM');await new Promise<void>(r=>{if(child.exitCode!==null)r();else child.once('exit',()=>r());});}
    const choices=[{id:'a',label:'A'},{id:'b',label:'B'},{id:'think',label:'THINK'}];
    const result=await selectForModel(registry,model,'test',choices,undefined,'aW1hZ2U=');assert.equal(result.choice,'b');
    const p=requests[0];assert.equal(p.model,'different-model');assert.equal(p.max_tokens,1);assert.equal(p.logprobs,true);assert.equal(p.chat_template_kwargs.enable_thinking,false);assert.equal(p.keep_alive,undefined);assert.ok(p.messages.some((m:any)=>Array.isArray(m.content)&&m.content.some((b:any)=>b.type==='image_url'&&b.image_url.url==='data:image/png;base64,aW1hZ2U=')));
    missing=true;assert.equal((await selectForModel(registry,model,'test',choices)).choice,null);
    await assert.rejects(selectForModel(registry,{...model,api:'anthropic-messages'},'test',choices),/SELECT/);assert.equal(requests.length,2);
    const controller=new AbortController();controller.abort();await assert.rejects(selectForModel(registry,model,'test',choices,controller.signal));assert.equal(requests.length,2);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
