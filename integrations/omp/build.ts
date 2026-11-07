// SPDX-License-Identifier: MIT OR Apache-2.0
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {relative,dirname} from 'node:path';
const requireNative=createRequire(import.meta.url);
const outdir=fileURLToPath(new URL('./dist/',import.meta.url));
let addon:string|undefined;
for(const platform of [process.platform, ...(process.platform==='linux'?['linuxmusl']:[])]){
  try{addon=requireNative.resolve(`@img/sharp-${platform}-${process.arch}/sharp.node`);break;}catch{}
}
if(!addon)throw new Error('Install the platform Sharp optional dependency before building the omp adapter');
const addonPath='./'+relative(outdir,addon).replaceAll('\\','/');
const sharpDir=dirname(requireNative.resolve('sharp'));
const result=await Bun.build({
  entrypoints:[fileURLToPath(new URL('./runtime.ts',import.meta.url))],
  outdir,naming:'nyatinorma.js',target:'node',format:'esm',
  define:{NYATINORMA_SHARP_ADDON_PATH:JSON.stringify(addonPath)},
  plugins:[{name:'stable-native-sharp',setup(build){
    build.onResolve({filter:/(^|[\\/])sharp\.(mjs|cjs)$/},args=>
      args.importer.startsWith(sharpDir)?{path:fileURLToPath(new URL('./native-sharp.ts',import.meta.url))}:undefined);
  }}],
});
if(!result.success)throw new AggregateError(result.logs,'Could not bundle shared sleepwalk runtime');
