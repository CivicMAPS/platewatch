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
  start(options:{mode:'walking'|'vehicle'}):Promise<void>;
  stop():Promise<void>;
  alert():Promise<void>;
  release(options:{path:string}):Promise<void>;
  addListener(event:'sighting', handler:(s:Sighting)=>void):Promise<PluginListenerHandle>;
  addListener(event:'finished', handler:()=>void):Promise<PluginListenerHandle>;
}
export const patrol = registerPlugin<PatrolPlugin>('PatrolCamera');
export const hasPatrol = () => Capacitor.isPluginAvailable('PatrolCamera');
export const frameUrlFor = (s:Sighting) => Capacitor.convertFileSrc(s.path);
