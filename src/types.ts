// SPDX-License-Identifier: MIT OR Apache-2.0
export type Box = {x:number;y:number;width:number;height:number};
export type Point = {x:number;y:number};
export type GridPoint = Point & {regionPath:string[]};
export type TargetCoordinates = {box?:Box;point?:Point;regionPath?:string[];gridPoint?:GridPoint};
export type DestinationCoordinates = {to?:Point;toRegionPath?:string[];toGridPoint?:GridPoint};
export type OCR = {text:string;confidence:number;box:Box};
export type WindowInfo = {windowId:number;pid:number;title:string;frame:Box};
export type Snapshot = {id:string;at:number;path:string;width:number;height:number;window:WindowInfo;ocr:OCR[]};
export type ActionKind = 'click'|'drag'|'wait'|'think';
export type Candidate = TargetCoordinates & DestinationCoordinates & {
  id:string;label:string;kind:ActionKind;
  intent:string;data?:Record<string,unknown>;
  requiredText?:string; targetText?:string; template?:string;
  targetAnchor?:{text:string;box:Box};
};
export type VisualAnchor = {box:Box;template:string};
export type SelectSet = {name:string;version:number;screen:string;purpose?:string;anchors:string[];visualAnchors?:VisualAnchor[];recognition?:'vision-only';candidates:Candidate[];createdFrom:string;createdAt:number};
export type Decision = {choice:string|null;probabilities:Record<string,number>;margin:number;legalMass:number;truncated:boolean;reason:string;elapsedMs:number;metrics?:unknown};
export type Progress = {schemaVersion:2;state:Record<string,unknown>;checkpoints:Record<string,{data:Record<string,unknown>;snapshotId:string;at:number}>;notes:string[];legacy?:Record<string,unknown>};
