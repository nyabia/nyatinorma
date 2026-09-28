// SPDX-License-Identifier: MIT OR Apache-2.0

export type PreviewResult={content:({type:'text';text:string}|{type:'image';data:string;mimeType:string})[];details:unknown};
export type PreviewUpdate=(result:PreviewResult)=>void;

/** Partial tool updates replace the TUI result. They are not returned to the
 * planner; only the actual final tool result belongs in conversation history. */
export function createLivePreview(enabled:()=>boolean,emit?:PreviewUpdate){
  let latest:string|undefined,lastLabel='Sleepwalk';
  function status(label:string){
    lastLabel=label;
    const visible=enabled()&&latest;
    try{emit?.({content:[{type:'text',text:label},...(visible?[{type:'image' as const,data:latest!,mimeType:'image/png'}]:[])],details:{livePreview:true,label}});}catch{/* Optional UI failure must not change an action's outcome. */}
  }
  return {
    status,
    async show(image:string|undefined,label=lastLabel){
      latest=enabled()?image:undefined;
      status(label);
    },
  };
}
