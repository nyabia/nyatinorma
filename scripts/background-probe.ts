// SPDX-License-Identifier: MIT OR Apache-2.0
import {capture,execute,closeDesktop} from '../src/desktop.js';
import {dataDir,saveJSON} from '../src/config.js';
import {resolve} from 'node:path';
// Explicit developer calibration only; never invoked by the model automatically.
const [kind,...args]=process.argv.slice(2);
if(!['click','drag'].includes(kind)||args.length!==(kind==='click'?2:4))throw new Error('Usage: npm run probe:background -- click x y | drag x y toX toY (normalized window coordinates)');
const values=args.map(Number);
if(values.some(n=>!Number.isFinite(n)||n<.01||n>.99))throw new Error('Coordinates must be in 0.01–0.99');
try{
  const before=await capture();
  const input=await execute({id:'probe',label:'Explicit calibration',kind:kind as 'click'|'drag',intent:'navigate',box:{x:values[0]-.001,y:values[1]-.001,width:.002,height:.002},...(kind==='drag'?{to:{x:values[2],y:values[3]}}:{})},before);
  await new Promise(r=>setTimeout(r,1800));const after=await capture();
  const report={at:Date.now(),input,before:{id:before.id,path:before.path},after:{id:after.id,path:after.path},note:'Dispatch is not proof of effect. Compare images; human pointer movement can affect diagnostics.'};
  await saveJSON(resolve(dataDir,`background-probe-${after.id}.json`),report);console.log(JSON.stringify(report,null,2));
}finally{await closeDesktop();}
