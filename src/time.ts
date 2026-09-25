// SPDX-License-Identifier: MIT OR Apache-2.0
import {currentRun} from './runtime.js';

const pad=(value:number)=>String(value).padStart(2,'0');
export function localISO(date:Date){
  const offset=-date.getTimezoneOffset(),sign=offset>=0?'+':'-',minutes=Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(minutes/60))}:${pad(minutes%60)}`;
}
export function parseStopAt(value:string){
  const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!match)throw new Error('stopAt requires an ISO date and time with explicit offset, e.g. YYYY-MM-DDTHH:mm:ss+09:00.');
  const epoch=Date.parse(value),zone=match[4];
  const offset=zone==='Z'?0:(zone[0]==='+'?1:-1)*(Number(zone.slice(1,3))*60+Number(zone.slice(4,6)));
  if(!Number.isFinite(epoch)||new Date(epoch+offset*60000).toISOString().slice(0,19)!==`${match[1]}T${match[2]}:${match[3]??'00'}`)throw new Error('Invalid calendar date/time for stopAt.');
  return epoch;
}
export function deadlineState(now=Date.now()){
  const stopAt=currentRun()?.stopAt;
  if(!stopAt)return null;
  const remainingMs=parseStopAt(stopAt)-now;
  return {stopAt,remainingSeconds:Math.max(0,Math.ceil(remainingMs/1000)),expired:remainingMs<=0};
}
export class DeadlineReached extends Error{constructor(){super('deadline_reached: configured stop time reached. Stop this task; do not extend or clear the deadline without a new user instruction.');}}
export function assertBeforeDeadline(durationMs=0,now=Date.now()){
  const stopAt=currentRun()?.stopAt;
  if(stopAt&&now+Math.max(0,durationMs)>=parseStopAt(stopAt))throw new DeadlineReached();
}
export function readClock(nextLocalTime?:string,now=Date.now()){
  const date=new Date(now);let nextOccurrence:undefined|{local:string;utc:string;secondsUntil:number};
  if(nextLocalTime!==undefined){
    if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(nextLocalTime))throw new Error('nextLocalTime must be HH:mm in the computer time zone.');
    const [hour,minute]=nextLocalTime.split(':').map(Number),next=new Date(now);
    next.setHours(hour,minute,0,0);
    if(next.getTime()<=now)next.setDate(next.getDate()+1);
    nextOccurrence={local:localISO(next),utc:next.toISOString(),secondsUntil:Math.ceil((next.getTime()-now)/1000)};
  }
  return {local:localISO(date),utc:date.toISOString(),epochMs:now,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,nextOccurrence,deadline:deadlineState(now)};
}
