// SPDX-License-Identifier: MIT OR Apache-2.0
import sharp from 'sharp';
import {crop,difference,fingerprint} from './vision.js';
import type {Box,Snapshot} from './types.js';

type Frame={snapshot:Snapshot;signature:string;index:number};
export type VisualMemoryData={frames:Frame[];observed:number;repeats:number};
// Local, bounded observations; a visual match is a recurrence hint, never semantic completion.
export class VisualMemory {
  private frames:Frame[]=[];
  private observed=0;
  private repeats=0;
  constructor(readonly region:Box,private capacity=100,saved?:VisualMemoryData){
    if(saved){this.frames=saved.frames.slice(-capacity);this.observed=saved.observed;this.repeats=saved.repeats;}
  }
  serialize():VisualMemoryData{return {frames:this.frames,observed:this.observed,repeats:this.repeats};}
  async observe(snapshot:Snapshot){
    const signature=await fingerprint(snapshot.path,this.region);let nearest:Frame|undefined,delta=1;
    for(const frame of this.frames){const error=difference(signature,frame.signature);if(error<delta){delta=error;nearest=frame;}}
    const revisited=Boolean(nearest&&delta<.025);this.repeats=revisited?this.repeats+1:0;
    const info={observed:++this.observed,distinctViews:this.frames.length+(revisited?0:1),revisited,consecutiveRevisits:this.repeats,closestSnapshotId:nearest?.snapshot.id,closestDelta:delta,firstSeenAt:nearest?.index};
    if(!revisited){this.frames.push({snapshot,signature,index:this.observed});if(this.frames.length>this.capacity)this.frames.splice(1,1);}
    return {info,reference:nearest?.snapshot};
  }
  async comparison(current:Snapshot,reference?:Snapshot){
    if(!reference||reference.id===current.id)return (await sharp(current.path).resize({width:1050,withoutEnlargement:true}).png().toBuffer()).toString('base64');
    const width=1050,full=await sharp(current.path).resize({width}).png().toBuffer(),meta=await sharp(full).metadata();
    const [before,now]=await Promise.all([crop(reference.path,this.region,520),crop(current.path,this.region,520)]);
    const height=Math.max((await sharp(before).metadata()).height!,(await sharp(now).metadata()).height!);
    const label=Buffer.from('<svg width="1050" height="30"><rect width="1050" height="30" fill="white"/><text x="10" y="21" font-size="17">PREVIOUSLY SEEN REGION</text><text x="535" y="21" font-size="17">CURRENT REGION</text></svg>');
    return (await sharp({create:{width,height:meta.height!+30+height,channels:3,background:'white'}}).composite([{input:full,top:0,left:0},{input:label,top:meta.height!,left:0},{input:before,top:meta.height!+30,left:0},{input:now,top:meta.height!+30,left:530}]).png().toBuffer()).toString('base64');
  }
}
