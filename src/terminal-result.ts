// SPDX-License-Identifier: MIT OR Apache-2.0
import {stripVTControlCharacters} from 'node:util';
import {Text,getCapabilities} from '@earendil-works/pi-tui';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import type {TSchema} from 'typebox';

// pi's extension loader aliases pi-tui to its own runtime instance, so terminal
// capability detection and overrides are shared with its native image renderer.
type ImageBlock={type:'image';data:string;mimeType:string};
type ImageCache={images:ImageBlock[];width:number;height:number;output?:string};

/** Only an adapter: terminal-image converts pixels, pi lays out and redraws.
 * Native images remain owned by pi (including Kitty image cleanup). ANSI stays
 * in renderer state, never in tool results, session files or model context. */
export const renderImageResult:NonNullable<ToolDefinition<TSchema,unknown,{nyImage?:ImageCache}>['renderResult']>=(result,_options,_theme,context)=>{
  const plain=result.content.filter(c=>c.type==='text').map(c=>stripVTControlCharacters(c.text).replace(/\r/g,'')).join('\n');
  const images=context.showImages&&!getCapabilities().images?result.content.filter((c):c is ImageBlock=>c.type==='image'):[];
  if(!images.length){context.state.nyImage=undefined;return new Text(plain,0,0);}
  const sameImages=(cache:ImageCache)=>cache.images.length===images.length&&cache.images.every((image,i)=>image.data===images[i].data&&image.mimeType===images[i].mimeType);
  if(context.state.nyImage&&!sameImages(context.state.nyImage))context.state.nyImage=undefined;
  const text=new Text('',0,0);
  return {
    invalidate:()=>text.invalidate(),
    render(availableWidth:number){
      const width=Math.max(1,Math.min(80,availableWidth));
      const height=Math.max(1,Math.min(20,Math.floor((process.stdout.rows||24)/2)));
      let cache=context.state.nyImage;
      if(!cache||cache.width!==width||cache.height!==height){
        cache={images,width,height};context.state.nyImage=cache;
        const pending=cache;
        // Conversion runs outside the SELECT path and is cached across status
        // updates. An obsolete frame may finish but cannot replace a newer one.
        void import('terminal-image').then(async({default:terminalImage})=>Promise.all(images.map(image=>terminalImage.buffer(Buffer.from(image.data,'base64'),{width,height,preferNativeRender:false})))).then(parts=>{
          pending.output=parts.join('\n');
        }).catch(()=>{pending.output='[이미지 미리보기를 표시할 수 없습니다.]';}).finally(()=>{
          if(context.state.nyImage===pending)context.invalidate();
        });
      }
      text.setText([plain,cache.output??'[이미지 변환 중]'].filter(Boolean).join('\n'));
      return text.render(availableWidth);
    },
  };
};
