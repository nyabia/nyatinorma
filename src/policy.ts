// SPDX-License-Identifier: MIT OR Apache-2.0
import type {Candidate} from './types.js';
import {validateBox} from './vision.js';
// Intent and metadata are model-defined; only mechanical input validity is checked here.
export function checkCandidate(c:Candidate) {
  if(c.kind==='think'||c.kind==='wait')return;
  if(!['click','drag'].includes(c.kind))throw new Error('Unsupported action kind');
  if(!c.box)throw new Error('A click/drag requires an observed bounding box.');
  validateBox(c.box);
  if(c.kind==='drag'&&(!c.to||![c.to.x,c.to.y].every(v=>Number.isFinite(v)&&v>=0&&v<=1)))throw new Error('Drag needs a normalized end point.');
}
