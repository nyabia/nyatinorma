// SPDX-License-Identifier: MIT OR Apache-2.0
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {dataDir,saveJSON,type Config} from './config.js';
export function mergeSettings(previous:Record<string,any>,c:Config):Record<string,any>{
  return {...(c.model?{defaultProvider:'nyatinorma-ollama',defaultModel:c.model}:{}),defaultThinkingLevel:'medium',quietStartup:true,enableSkillCommands:false,
    compaction:{enabled:true,reserveTokens:8192,keepRecentTokens:12000},retry:{enabled:false,maxRetries:0},...previous};
}
export async function initializePiSettings(c:Config){
  const path=resolve(dataDir,'pi','settings.json');let previous={};
  try{previous=JSON.parse(await readFile(path,'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
  await saveJSON(path,mergeSettings(previous,c));
  // Never rewrite models.json: users may maintain their own provider entries.
}
