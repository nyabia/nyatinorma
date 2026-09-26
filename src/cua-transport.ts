// SPDX-License-Identifier: MIT OR Apache-2.0
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export class CuaSessionRestoredError extends Error {
  constructor(){super('Cua session was restored; the input was rejected and was not replayed. Fresh-screen verification is required before retry.');this.name='CuaSessionRestoredError';}
}
export class CuaTimeoutError extends Error {
  constructor(readonly operation:string){super(`Cua ${operation} timed out. ${['click','drag'].includes(operation)?'Input outcome unknown; do not replay automatically.':'No new observation was obtained.'}`);this.name='CuaTimeoutError';}
}
// Own only this MCP client and its explicitly named session, never the daemon.
export class CuaTransport {
  readonly session=`nyatinorma-${process.pid}-${randomUUID().slice(0,8)}`;
  private child?:ChildProcessWithoutNullStreams;
  private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private serial=0;private ready?:Promise<void>;private named=false;
  constructor(private executable:string,private args=['mcp'],private timeoutMs=180_000){}
  private async connect(){
    if(this.ready)return this.ready;
    this.ready=(async()=>{
      const child=spawn(this.executable,this.args,{stdio:'pipe'});this.child=child;let buffer='',stderr='';
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
      const fail=(error:Error)=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();};
      child.on('error',fail);child.on('exit',()=>{fail(new Error(`Cua MCP connection ended: ${stderr}`));this.ready=undefined;this.child=undefined;this.named=false;});
      child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
        buffer+=chunk;let end;
        while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
          let row:any;try{row=JSON.parse(line);}catch{continue;}
          const p=this.pending.get(row.id);if(!p)continue;clearTimeout(p.timer);this.pending.delete(row.id);row.error?p.reject(new Error(JSON.stringify(row.error))):p.resolve(row.result);
        }
      });
      await this.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'nyatinorma',version:'0.2.0'}});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    })();return this.ready;
  }
  private request(method:string,params:any):Promise<any>{
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new CuaTimeoutError(params?.name??method));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      this.child!.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
    });
  }
  private endedSession(result:any,name:string){
    if(!result?.isError)return false;
    const message=(result.content??[]).filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('\n');
    return message.includes(`session '${this.session}' has ended; tool call '${name}' was rejected`);
  }
  async call(name:string,args:Record<string,unknown>={},withSession=false,signal?:AbortSignal):Promise<any>{
    const allowed=['list_windows','list_apps','check_permissions','get_cursor_position','get_window_state','click','drag','start_session','end_session'];
    if(!allowed.includes(name))throw new Error(`Cua operation not allowed by nyatinorma: ${name}`);
    signal?.throwIfAborted();await this.connect();signal?.throwIfAborted();
    if(withSession&&!this.named){await this.call('start_session',{session:this.session,capture_scope:'window'});this.named=true;}
    signal?.throwIfAborted();
    const params={name,arguments:{...args,...(withSession?{session:this.session}:{})}};
    let result=await this.request('tools/call',params);
    if(withSession&&this.endedSession(result,name)){
      // The MCP proxy can remain alive after the driver's named session expires.
      // Revive only our session. Never restart or reconfigure the shared daemon.
      this.named=false;signal?.throwIfAborted();
      await this.call('start_session',{session:this.session,capture_scope:'window'},false,signal);
      this.named=true;signal?.throwIfAborted();
      // Reacquire an image after recovery; do not replay input based on an old one.
      if(name!=='get_window_state')throw new CuaSessionRestoredError();
      result=await this.request('tools/call',params);
      if(this.endedSession(result,name)){
        this.named=false;
        throw new Error('Cua session recovery failed after one attempt. Stop and report the connection failure instead of repeating ny_observe or ny_run resume.');
      }
    }
    if(result.isError)throw new Error((result.content??[]).filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('\n'));
    if(result.structuredContent)return result.structuredContent;
    const text=(result.content??[]).filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('\n');
    try{return JSON.parse(text);}catch{return {text,content:result.content};}
  }
  async close(){
    if(!this.child)return;
    try{if(this.named)await this.call('end_session',{session:this.session});}finally{
      // SIGTERM addresses only the proxy process spawned above, never CuaDriver.app.
      this.named=false;this.child?.stdin.end();this.child?.kill('SIGTERM');
    }
  }
}
