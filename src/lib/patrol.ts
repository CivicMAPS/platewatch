import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { TextLine } from './nativeOcr';

export type PatrolMode = 'walking' | 'vehicle';
export type CaptureMode = 'single' | 'multi';

export interface Sighting {
  /** Plate read by ML Kit; empty for a shutter capture where no plate-shaped text was read. */
  plate:string;
  at:number;
  path:string;
  x:number;
  y:number;
  width:number;
  height:number;
  /** True when the officer pressed the shutter; false for an automatic Multi capture. */
  manual?:boolean;
  zoom?:number;
  captureMode?:CaptureMode;
}

/** Battery, charging, battery temperature and Android thermal status (0 none … 6 shutdown). */
export interface DeviceStatus {
  battery?:number;
  charging?:boolean;
  batteryTempC?:number;
  thermal?:number;
}

/** Recognition and power counters reported every 30 s while diagnostics are on. */
export interface PatrolStats extends DeviceStatus {
  patrolMode:PatrolMode;
  captureMode:CaptureMode;
  seconds:number;
  framesPerMinute:number;
  readsPerMinute:number;
  ocrMsAvg:number;
  lines:number;
  plateLines:number;
  captures:number;
  zoom:number;
  zoomMin:number;
  zoomMax:number;
  frameWidth:number;
  frameHeight:number;
}

interface PatrolPlugin {
  /** `zoom` is the starting zoom ratio; `presets` are the steps of the zoom button. */
  start(options:{mode:PatrolMode; captureMode:CaptureMode; zoom:number; presets:number[]; diagnostics:boolean}):Promise<void>;
  stop():Promise<void>;
  alert():Promise<void>;
  release(options:{path:string}):Promise<void>;
  /** ML Kit text lines in a JPEG data URL, in image pixels. */
  readText(options:{image:string}):Promise<{lines:TextLine[]; width:number; height:number; durationMs:number}>;
  deviceStatus():Promise<DeviceStatus>;
  addListener(event:'sighting', handler:(s:Sighting)=>void):Promise<PluginListenerHandle>;
  addListener(event:'finished', handler:()=>void):Promise<PluginListenerHandle>;
  /** The officer settled on a new zoom; persisted so the next session starts there. */
  addListener(event:'zoom', handler:(z:{ratio:number})=>void):Promise<PluginListenerHandle>;
  addListener(event:'stats', handler:(s:PatrolStats)=>void):Promise<PluginListenerHandle>;
  /** Lens zoom range, reported once per patrol while diagnostics are on. */
  addListener(event:'camera', handler:(c:{zoomMin:number; zoomMax:number})=>void):Promise<PluginListenerHandle>;
}
export const patrol = registerPlugin<PatrolPlugin>('PatrolCamera');
export const hasPatrol = () => Capacitor.isPluginAvailable('PatrolCamera');
export const frameUrlFor = (s:Sighting) => Capacitor.convertFileSrc(s.path);
