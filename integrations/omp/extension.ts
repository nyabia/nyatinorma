// SPDX-License-Identifier: MIT OR Apache-2.0
import type {ExtensionAPI} from '@oh-my-pi/pi-coding-agent';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
export default function nyatinorma(pi:ExtensionAPI){
  const runtime=new URL('./dist/nyatinorma.js',import.meta.url).href;
  const guide=fileURLToPath(new URL('./USAGE.md',import.meta.url));
  const state=new URL('./state/',import.meta.url),cancellationFile=fileURLToPath(new URL(`cancel-${randomUUID()}.txt`,state));
  let initialized=false;
  const cancel=async()=>{
    if(!initialized)return;
    const temporary=cancellationFile+'.tmp';await writeFile(temporary,randomUUID());await rename(temporary,cancellationFile);
  };
  pi.on('input',async()=>{await cancel();return {action:'continue' as const};});
  pi.on('session_shutdown',async()=>{await cancel();});
  pi.setLabel('nyatinorma-omp');
  pi.registerTool({name:'nyatinorma_setup',label:'Nyatinorma sleepwalk setup',approval:'read',description:'Load shared Nyatinorma sleepwalk into JavaScript Eval. Uses existing computer input; host judge or optional shared System One decisions. Goal methods: wait, scroll, act, status, stop, resume. Read the guide first. No input is sent by setup.',parameters:pi.zod.object({}),async execute(){
    await mkdir(state,{recursive:true});if(!initialized){await writeFile(cancellationFile,randomUUID());initialized=true;}
    const hostOptions=`{ cancellationFile: ${JSON.stringify(cancellationFile)} }`;
    // 설치 시 발견한 플러그인 경로를 별도 Eval 커널에서 동적으로 로드한다.
    const bootstrap=`const { createNyatinorma } = await import(${JSON.stringify(runtime)});`;
    const setup=`${bootstrap}\nconst ny = createNyatinorma({ computer, judge }, ${hostOptions});`;
    const explicit=`${bootstrap}\nconst ny = createNyatinorma({ computer, judge }, { cancellationFile: ${JSON.stringify(cancellationFile)}, decision: { mode:'systemone', url:'http://127.0.0.1:11434', model:'d3:4b', wire:'ollama', fallback:true } });`;
    return {content:[{type:'text',text:`Read ${guide} first. Choose ONE bootstrap and run it ONCE in JavaScript Eval; reuse ny across cells.\nHost judge:\n${setup}\nShared native Ollama d3 vision (does not modify omp models):\n${explicit}\nGoal API: ny.wait / ny.scroll / ny.act; await ny.status(); ny.stop(); await ny.resume(). User-input/session-shutdown cancellation marker is connected; Escape/host-interrupt is not assumed equivalent. Do not replace a runtime to bypass unresolved input. No computer input has been sent.`}],details:{runtime,guide,setup,explicit,cancellationFile}};
  }});
}
