// SPDX-License-Identifier: MIT OR Apache-2.0
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {writeFile,access} from 'node:fs/promises';
import {config,root,dataDir,saveJSON} from './config.js';
import {native,capture,closeDesktop} from './desktop.js';
import {select,chat} from './ollama.js';
import {initTasks,task} from './tasks.js';
import {initializePiSettings} from './settings.js';

const c=await config();await initTasks();
const command=process.argv[2]??'tui';
try {
  if(command==='doctor') {
    const [permissions,version,models]=await Promise.allSettled([
      native({action:'doctor'}),fetch(`${c.ollamaUrl}/api/version`).then(r=>r.json()),fetch(`${c.ollamaUrl}/api/tags`).then(r=>r.json())
    ]);
    console.log(JSON.stringify({node:process.version,permissions,ollama:version,model:c.model,
      modelInstalled:models.status==='fulfilled'&&(models.value as any).models.some((m:any)=>m.name===c.model)},null,2));
  }else if(command==='permissions')console.log(JSON.stringify(await native({action:'permissions'}),null,2));
  else if(command==='bridge-restart'){
    await native({action:'shutdown'});await new Promise(r=>setTimeout(r,300));console.log(JSON.stringify(await native({action:'doctor'}),null,2));
  }else if(command==='observe')console.log(JSON.stringify(await capture(),null,2));
  else if(command==='probe') {
    const result=await select('Select the number two.',[{id:'one',label:'number one'},{id:'two',label:'number two'},{id:'think',label:'THINK: cannot decide'}]);
    await saveJSON(resolve(dataDir,'probe.json'),result);console.log(JSON.stringify(result,null,2));
    if(result.choice!=='two')process.exitCode=1;
  }else if(command==='vision-probe'){
    const {readFile}=await import('node:fs/promises');const sharp=(await import('sharp')).default;
    const s=await capture();const image=await sharp(s.path).resize({width:1050}).png().toBuffer();
    const start=performance.now();const response=await chat({think:false,messages:[{role:'user',content:'이 앱 화면의 주요 메뉴와 보이는 상태를 짧게 설명하세요. 보이지 않는 것은 추측하지 마세요.',images:[image.toString('base64')]}],options:{num_predict:200}});
    console.log(JSON.stringify({snapshotId:s.id,elapsedMs:performance.now()-start,message:response.message,metrics:{prefillMs:response.prompt_eval_duration/1e6,decodeMs:response.eval_duration/1e6}},null,2));
  }else if(command==='tui'||command==='pi') {
    if(c.driver==='macos-legacy')await access(resolve(root,'Nyatinorma Bridge.app/Contents/MacOS/nyatinorma-macos'));
    // The extension registers the native Ollama transport; discard old compatible-API overrides.
    await initializePiSettings(c);
    const args=[resolve(root,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
      '--no-builtin-tools','--no-extensions','--no-skills','--no-context-files','--no-prompt-templates',
      '--extension',resolve(root,'extensions/nyatinorma.ts'),'--offline',...process.argv.slice(3)];
    const child=spawn(process.execPath,args,{cwd:root,stdio:'inherit',env:{...process.env,PI_CODING_AGENT_DIR:resolve(dataDir,'pi'),PI_OFFLINE:'1'}});
    child.on('exit',(code)=>process.exit(code??1));
    process.on('SIGTERM',()=>child.kill('SIGTERM'));
  }else throw new Error(`Unknown command ${command}`);
}catch(e:any){console.error(`nyatinorma: ${e.message}`);process.exitCode=1;}finally{await closeDesktop();}
