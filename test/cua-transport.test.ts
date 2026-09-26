// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CuaTransport} from '../src/cua-transport.js';

test('MCP client changes only its unique session and rejects shared-driver management calls',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-cua-')),log=join(dir,'calls.jsonl'),server=join(dir,'server.cjs');
  await writeFile(server,`const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);if(!r.id)return;if(r.method==='tools/call')fs.appendFileSync(process.argv[2],JSON.stringify(r.params)+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fake',version:'1'}}:{structuredContent:{ok:true},content:[]}})+'\\n');});`);
  const a=new CuaTransport(process.execPath,[server,log]),b=new CuaTransport(process.execPath,[server,log]);
  try{
    assert.notEqual(a.session,b.session);
    await assert.rejects(a.call('set_config',{capture_scope:'desktop'}),/not allowed/);
    await assert.rejects(a.call('stop'),/not allowed/);
    await a.call('get_window_state',{pid:7,window_id:8},true);
    await b.call('get_window_state',{pid:7,window_id:8},true);
    await a.close();await b.close();
    const calls=(await readFile(log,'utf8')).trim().split('\n').map(l=>JSON.parse(l));
    for(const session of [a.session,b.session]){
      const mine=calls.filter(v=>v.arguments.session===session);
      assert.deepEqual(mine.map(v=>v.name),['start_session','get_window_state','end_session']);assert.equal(mine[0].arguments.capture_scope,'window');
    }
    assert.equal(calls.length,6);
  }finally{await a.close();await b.close();await rm(dir,{recursive:true,force:true});}
});

test('cancellation during MCP initialization prevents delayed input dispatch',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ny-cua-cancel-')),log=join(dir,'calls.jsonl'),server=join(dir,'server.cjs');
  await writeFile(server,`const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);if(!r.id)return;if(r.method==='tools/call')fs.appendFileSync(process.argv[2],JSON.stringify(r.params)+'\\n');setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{structuredContent:{ok:true},content:[]}})+'\\n'),r.method==='initialize'?100:0);});`);
  const client=new CuaTransport(process.execPath,[server,log]),controller=new AbortController();
  try{
    const click=client.call('click',{pid:7,window_id:8,x:10,y:10},true,controller.signal);
    controller.abort();await assert.rejects(click,/abort/i);
    await assert.rejects(readFile(log),{code:'ENOENT'});
  }finally{await client.close();await rm(dir,{recursive:true,force:true});}
});

async function expiredServer(mode:string,body:(client:CuaTransport,calls:()=>Promise<any[]>)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'ny-cua-expiry-')),log=join(dir,'calls.jsonl'),server=join(dir,'server.cjs');
  await writeFile(server,`const fs=require('node:fs');let attempts=0,starts=0;const mode=process.argv[3];
const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{
 const r=JSON.parse(line);if(!r.id)return;let result={structuredContent:{ok:true},content:[]},delay=0;
 if(r.method==='tools/call'){
  const p=r.params;fs.appendFileSync(process.argv[2],JSON.stringify(p)+'\\n');
  if(p.name==='start_session'){starts++;if(mode==='abort'&&starts===2)delay=150;}
  if(p.name==='get_window_state'||p.name==='click'){
   attempts++;
   if(attempts===1||mode==='persistent')result={isError:true,content:[{type:'text',text:mode==='ordinary'?'Input outcome unknown':mode==='foreign'?"session 'someone-else' has ended; tool call '"+p.name+"' was rejected.":"session '"+p.arguments.session+"' has ended; tool call '"+p.name+"' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id."}]};
  }
 }
 setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n'),delay);
});`);
  const client=new CuaTransport(process.execPath,[server,log,mode]);
  const calls=async()=>{try{return (await readFile(log,'utf8')).trim().split('\n').map(l=>JSON.parse(l));}catch(e:any){if(e.code==='ENOENT')return [];throw e;}};
  try{await body(client,calls);}finally{await client.close();await rm(dir,{recursive:true,force:true});}
}

test('expired Cua session is revived once and capture retried on the same private session',async()=>{
  await expiredServer('once',async(client,calls)=>{
    assert.deepEqual(await client.call('get_window_state',{pid:7,window_id:8},true),{ok:true});
    const rows=await calls();assert.deepEqual(rows.map(r=>r.name),['start_session','get_window_state','start_session','get_window_state']);
    assert.ok(rows.every(r=>r.arguments.session===client.session));
    assert.deepEqual(rows[0],rows[2]);assert.deepEqual(rows[1],rows[3]);
  });
});

test('persistent expiry has a bounded recovery attempt',async()=>{
  await expiredServer('persistent',async(client,calls)=>{
    await assert.rejects(client.call('get_window_state',{},true),/recovery failed after one attempt/);
    assert.equal((await calls()).length,4);
  });
});

test('session recovery never replays a click and requires a fresh observation',async()=>{
  await expiredServer('once',async(client,calls)=>{
    await assert.rejects(client.call('click',{x:1,y:2},true),/not replayed.*verification/);
    assert.deepEqual((await calls()).map(r=>r.name),['start_session','click','start_session']);
    assert.deepEqual(await client.call('get_window_state',{},true),{ok:true});
  });
});

for(const mode of ['ordinary','foreign'])test(`does not recover or replay ${mode} errors`,async()=>{
  await expiredServer(mode,async(client,calls)=>{
    await assert.rejects(client.call('get_window_state',{},true));
    assert.deepEqual((await calls()).map(r=>r.name),['start_session','get_window_state']);
  });
});

test('cancellation while restoring a session prevents the retry',async()=>{
  await expiredServer('abort',async(client,calls)=>{
    const controller=new AbortController();
    const pending=assert.rejects(client.call('get_window_state',{},true,controller.signal),/abort/i);
    const deadline=Date.now()+5000;
    while((await calls()).filter(r=>r.name==='start_session').length<2){
      if(Date.now()>deadline)throw new Error('Recovery did not start');
      await new Promise(r=>setTimeout(r,10));
    }
    controller.abort();await pending;
    assert.deepEqual((await calls()).map(r=>r.name),['start_session','get_window_state','start_session']);
  });
});
