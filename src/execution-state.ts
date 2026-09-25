// SPDX-License-Identifier: MIT OR Apache-2.0
import {currentRun} from './runtime.js';
import {assertBeforeDeadline} from './time.js';

/** Explicit model stop and user deadline only; no inferred failure/retry budget. */
export function assertCanExecute(durationMs=0){
  // Use the established runtime API. A lazily loaded driver can otherwise see
  // an older runtime namespace during a live source update, before /reload.
  if(currentRun()?.status==='blocked')throw new Error('run_blocked: 이 실행은 진행 불가로 중단되었습니다. 사용자가 /play [교정 내용]으로 재개해야 합니다.');
  assertBeforeDeadline(durationMs);
}
