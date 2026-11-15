import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {HttpError} from './errors.js';
import type {Box} from './types.js';

export interface PixelSeed {key:string;box:Box;frameId:number}
export interface PixelFrame {frameId:number;boxes:{key:string;box:Box}[];processingMs:number}

/** A separate, bounded geometry process; semantic inference never blocks it. */
export function createPixelTracker(python:string,backend:string,env:NodeJS.ProcessEnv){
  const child=spawn(python,['-u',resolve(backend,'ai/pixel_tracking.py')],{
    cwd:backend,env,windowsHide:true,stdio:['pipe','pipe','pipe'],
  });
  let sequence=0,closed=false;
  const pending=new Map<number,{resolve:(r:PixelFrame)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const fail=(error:Error)=>{for(const job of pending.values()){clearTimeout(job.timer);job.reject(error);}pending.clear();};
  child.on('error',fail);child.stdin.on('error',fail);
  child.on('exit',()=>{closed=true;fail(new HttpError(503,'Luồng bám hình ảnh đã dừng.'));});
  // Drain diagnostics without mixing them with the line-oriented protocol.
  child.stderr.on('data',()=>{});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    let message;try{message=JSON.parse(line);}catch{return;}
    const job=pending.get(message.id);if(!job)return;
    pending.delete(message.id);clearTimeout(job.timer);
    if(message.error)job.reject(new HttpError(422,message.error));else job.resolve(message);
  });
  const write=(message:unknown)=>{if(!closed)child.stdin.write(JSON.stringify(message)+'\n');};
  return {
    track(jpeg:Buffer,session:string,frameId:number,capturedAt?:number):Promise<PixelFrame>{
      if(closed)return Promise.reject(new HttpError(503,'Luồng bám hình ảnh đã dừng.'));
      if(pending.size>=8)return Promise.reject(new HttpError(429,'Luồng bám hình ảnh đang bận.'));
      const id=++sequence;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(new HttpError(504,'Bám hình ảnh quá thời gian.'));},2000);
        pending.set(id,{resolve,reject,timer});write({type:'frame',id,session,frameId,capturedAt,image:jpeg.toString('base64')});
      });
    },
    seed(session:string,seeds:PixelSeed[]){write({type:'seed',session,seeds});},
    release(session:string){write({type:'release',session});},
    async close(){
      if(closed)return;closed=true;fail(new HttpError(503,'Backend đang dừng.'));lines.close();child.stdin.end();
      await new Promise<void>(yes=>{const timer=setTimeout(()=>{child.kill();yes();},2000);
        child.once('exit',()=>{clearTimeout(timer);yes();});if(child.exitCode!==null){clearTimeout(timer);yes();}});
    },
  };
}
