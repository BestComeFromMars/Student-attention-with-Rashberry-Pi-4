import type { ActionObservation } from './types.js';

/** Independent multi-label confirmation. Cached observations never renew it. */
export class ActionEvaluator {
  private people=new Map<string,Map<string,{since:number;at:number;samples:number}>>();
  retain(ids:Set<string>){for(const id of this.people.keys())if(!ids.has(id))this.people.delete(id);}
  evaluate(id:string,input:ActionObservation[]|undefined,now:number):ActionObservation[]{
    let timers=this.people.get(id);if(!timers){timers=new Map();this.people.set(id,timers);}
    const present=new Set((input??[]).map(action=>action.type));
    for(const type of timers.keys())if(!present.has(type as ActionObservation['type']))timers.delete(type);
    return (input??[]).map(action=>{
      if(!Number.isFinite(action.observedAt)||action.observedAt>now||now-action.observedAt>2500||action.state==='unavailable'){
        timers!.delete(action.type);return {...action,state:'unavailable',durationMs:0};
      }
      if(action.state==='clear'){timers!.delete(action.type);return {...action,durationMs:0};}
      let timer=timers!.get(action.type);
      if(!timer||action.observedAt<timer.at||action.observedAt-timer.at>2500)timer={since:action.observedAt,at:action.observedAt,samples:1};
      else if(action.observedAt>timer.at){timer.at=action.observedAt;timer.samples++;}
      timers!.set(action.type,timer);
      const durationMs=timer.at-timer.since;
      return {...action,state:timer.samples>=2&&durationMs>=(action.type==='slumped_on_desk'?1500:500)?'confirmed':'pending',durationMs};
    });
  }
}
