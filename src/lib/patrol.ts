import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface Sighting {
  plate:string;
  at:number;
  path:string;
  x:number;
  y:number;
  width:number;
  height:number;
}
interface PatrolPlugin {
  /** `zoom` is the starting zoom ratio; `presets` are the quick-zoom buttons shown. */
  start(options:{mode:'walking'|'vehicle'; zoom:number; presets:number[]}):Promise<void>;
  stop():Promise<void>;
  alert():Promise<void>;
  release(options:{path:string}):Promise<void>;
  addListener(event:'sighting', handler:(s:Sighting)=>void):Promise<PluginListenerHandle>;
  addListener(event:'finished', handler:()=>void):Promise<PluginListenerHandle>;
  /** The officer settled on a new zoom; persisted so the next session starts there. */
  addListener(event:'zoom', handler:(z:{ratio:number})=>void):Promise<PluginListenerHandle>;
}
export const patrol = registerPlugin<PatrolPlugin>('PatrolCamera');
export const hasPatrol = () => Capacitor.isPluginAvailable('PatrolCamera');
export const frameUrlFor = (s:Sighting) => Capacitor.convertFileSrc(s.path);
