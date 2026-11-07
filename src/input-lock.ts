// SPDX-License-Identifier: MIT OR Apache-2.0
import {executionHost} from './host-context.js';
type Lock={active:boolean;pending?:string};
const key=Symbol.for('nyatinorma.input-locks');
const shared=globalThis as unknown as Record<symbol,Map<string,Lock>|undefined>;
const locks=shared[key]??=new Map<string,Lock>();
function lock(){const scope=executionHost()?.inputScope??'desktop';let value=locks.get(scope);if(!value){value={active:false};locks.set(scope,value);}return value;}
export function pendingInput(){return lock().pending;}
export function recordPendingInput(id:string,pending:boolean){const value=lock();if(pending){if(value.pending&&value.pending!==id)throw new Error(`Input outcome unresolved in continuation ${value.pending}`);value.pending=id;}else if(value.pending===id)value.pending=undefined;}
export function acquireInput(resume?:string){const value=lock();if(value.active)throw new Error('An input executor is already active.');if(value.pending&&value.pending!==resume)throw new Error(`Input outcome unresolved in continuation ${value.pending}; resume before another input.`);value.active=true;return ()=>{value.active=false;};}
