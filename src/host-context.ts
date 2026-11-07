// SPDX-License-Identifier: MIT OR Apache-2.0
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Config} from './config.js';
import type {Continuation} from './execution-contract.js';
import type {Snapshot} from './types.js';

// 호스트는 원본 앱의 활성 실행·설정·저장소에 접근하지 않고 같은 실행기를 쓴다.
export type ExecutionHost={
  id:string;
  inputScope?:string;
  // 호스트가 명시한 실행별 등록 저장소만 사용하며 독립 실행 저장소로 우회하지 않는다.
  actPointDirectory?:string;
  config:()=>Promise<Config>;
  loadContinuation:(id?:string)=>Promise<Continuation|undefined>;
  saveContinuation:(value:Continuation)=>Promise<void>;
  snapshot:(id:string)=>Promise<Snapshot|undefined>;
  deadlineAt?:number;
};
const context=new AsyncLocalStorage<ExecutionHost>();
export function executionHost(){return context.getStore();}
export function withExecutionHost<T>(host:ExecutionHost,run:()=>T):T{return context.run(host,run);}
export async function executionSnapshot(id:string){
  const host=executionHost();
  return host?host.snapshot(id):import('./store.js').then(m=>m.snapshot(id)).catch(()=>undefined);
}
