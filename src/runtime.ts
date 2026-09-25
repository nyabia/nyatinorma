// SPDX-License-Identifier: MIT OR Apache-2.0
import type {Task} from './tasks.js';
export type BlockedReport={reason:string;attempts:string[];needed:string;progress?:string;snapshotId?:string;at:number;resumedAt?:number};
export type Run={id:string;title:string;preset:Task;status:'ready'|'paused'|'completed'|'blocked';createdAt:number;updatedAt:number;legacy?:boolean;anonymous?:boolean;scenario?:string|null;knowledgeApp?:string;stopAt?:string|null;blocked?:BlockedReport};
let bound:Run|null=null;
let observedAfter=0;
export function currentRun(){return bound;}
export function currentScenario(){return bound?.scenario===undefined?(bound?.preset.id==='scratch'?undefined:bound?.preset.id):bound.scenario??undefined;}
export function bindRun(run:Run|null){bound=run;observedAfter=Date.now();}
export function requireRun(){if(!bound)throw new Error('현재 기록이 연결되지 않았습니다. 새 대화를 열거나 /runs로 저장된 기록을 연결하세요.');return bound;}
export function assertRunNotBlocked(){if(bound?.status==='blocked')throw new Error('run_blocked: 이 실행은 모델이 진행 불가로 중단했습니다. 사유를 확인하고 사용자가 /play [교정 내용]으로 재개해야 합니다.');}
export function requireFreshObservation(at:number){requireRun();if(at<observedAfter)throw new Error('실행을 시작/재개한 뒤 ny_observe로 새 화면을 확인하세요. 과거 대화나 게임 화면은 현재 상태가 아닙니다.');}
