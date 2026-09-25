// SPDX-License-Identifier: MIT OR Apache-2.0
let active=false;
export function acquireInput(){if(active)throw new Error('An input executor is already active.');active=true;return ()=>{active=false;};}
