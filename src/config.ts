// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export const root = resolve(import.meta.dirname, '..');
export const dataDir = resolve(process.env.NYATINORMA_DATA_DIR??resolve(root, '.nyatinorma'));
export type Config = {
  ollamaThinkingMode:'boolean'|'levels';
  knowledgeAppId?:string;
  contextWindow:number;maxTokens:number;reasoning:boolean;
  driver:'cua'|'macos-legacy';dragDriver:'cua'|'macos-bridge';cuaDriverPath:string;cuaModifiers:string[];targetApp:string;targetPid?:number;targetWindowId?:number;
  ollamaUrl: string; model: string; bundleId: string;
  maxSteps: number; maxRunSeconds: number; ollamaTimeoutSeconds: number; desktopTimeoutSeconds:number;
  selectMinMass: number; selectMinMargin: number; templateMaxError: number;
  inputMode:'background'|'foreground'; showAgentPointer:boolean; dragDurationMs:number;
};
export const defaults: Config = {
  ollamaThinkingMode:'boolean',
  contextWindow:32768,maxTokens:4096,reasoning:true,
  driver:'cua',dragDriver:'cua',cuaDriverPath:'cua-driver',cuaModifiers:[],targetApp:'',
  ollamaUrl:'http://127.0.0.1:11434', model:'', bundleId:'',
  maxSteps:20, maxRunSeconds:900, ollamaTimeoutSeconds:600, desktopTimeoutSeconds:180,
  selectMinMass:0.5, selectMinMargin:0.2, templateMaxError:0.12,
  inputMode:'background',showAgentPointer:true,dragDurationMs:1100,
};
export async function initialize() {
  for (const dir of ['captures','sets','traces','pi','bin']) await mkdir(resolve(dataDir,dir),{recursive:true});
}
export async function config(): Promise<Config> {
  await initialize();
  let overrides = {};
  try { overrides = JSON.parse(await readFile(resolve(root,'nyatinorma.json'),'utf8')); }
  catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  return {...defaults,...overrides, ...(process.env.NYATINORMA_OLLAMA_URL ? {ollamaUrl:process.env.NYATINORMA_OLLAMA_URL} : {}),...(process.env.NYATINORMA_MODEL ? {model:process.env.NYATINORMA_MODEL} : {})};
}
export async function saveJSON(path: string, value: unknown) {
  const {rename} = await import('node:fs/promises');
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp,JSON.stringify(value,null,2)+'\n'); await rename(tmp,path);
}
