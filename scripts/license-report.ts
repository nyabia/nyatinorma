// SPDX-License-Identifier: MIT OR Apache-2.0
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const lock=JSON.parse(await readFile(resolve(root,'package-lock.json'),'utf8'));
const packages=Object.entries(lock.packages as Record<string,any>).filter(([path])=>path).map(([path,p])=>({
  name:p.name??path.split('node_modules/').at(-1),version:p.version,license:p.license??'UNSPECIFIED',
  development:Boolean(p.dev),optional:Boolean(p.optional),lockfilePath:path,
})).sort((a,b)=>a.lockfilePath.localeCompare(b.lockfilePath));
await writeFile(resolve(root,'docs/dependency-licenses.json'),JSON.stringify({
  source:'package-lock.json',notice:'Declared metadata only; includes optional and development packages, not a complete binary notice bundle.',packages,
},null,2)+'\n');
console.log(`Recorded ${packages.length} dependency license declarations.`);
