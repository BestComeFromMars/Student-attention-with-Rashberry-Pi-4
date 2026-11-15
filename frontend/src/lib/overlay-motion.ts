import {topRightLabel} from './overlay-anchor';

type Shape = {node:Element;attributes:string[];from:number[];to:number[];start:number;duration:number;anchorKey?:string};
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

/** One display clock for all rectangles, labels and leaders. AI data stays
 * untouched. Only positions between already received results are interpolated. */
export class OverlayMotion {
  private shapes=new Map<string,Shape>();
  private previousAt:number|undefined;
  private duration=120;
  private scope='';
  private frame:number|undefined;
  private automatic=false;
  updates=0;
  animatedFrames=0;

  private elements(root:Element){
    const result:{key:string;node:Element;attributes:string[];anchorKey?:string}[]=[];
    for(const [selector,kind] of [['[data-person-id]','person'],['[data-face-id]','face'],['[data-object-id]','object'],
      ['[data-person-label]','person-label'],['[data-object-label]','object-label']]){
      for(const group of root.querySelectorAll(selector)){
        const id=group.getAttribute(selector.slice(1,-1));
        for(const [child,attributes] of [[':scope > rect','x,y,width,height'],[':scope > line','x1,y1,x2,y2'],
          [':scope > .observation-label','x,y']] ){
          const node=group.querySelector(child);
          if(node){
            const anchor=node.getAttribute('data-anchor-frame');
            result.push({key:`${kind}:${id}:${child}`,node,attributes:attributes.split(','),
              anchorKey:anchor?`${anchor}::scope > rect`:undefined});
          }
        }
      }
    }
    return result;
  }

  private sample(shape:Shape,at:number){
    const t=shape.duration?clamp((at-shape.start)/shape.duration,0,1):1;
    return shape.from.map((value,index)=>value+(shape.to[index]-value)*t);
  }

  private write(shape:Shape,values:number[]){
    shape.attributes.forEach((attribute,index)=>shape.node.setAttribute(attribute,String(values[index])));
  }

  private drawShape(shape:Shape,at:number){
    const source=shape.anchorKey?this.shapes.get(shape.anchorKey):undefined;
    if(source){
      const [x,y,width,height]=this.sample(source,at);
      const viewport=shape.node.parentElement?.closest('svg');
      const label=topRightLabel({x,y,width,height},{width:Number(shape.node.getAttribute('width')),height:Number(shape.node.getAttribute('height'))},
        {width:Number(viewport?.getAttribute('width')),height:Number(viewport?.getAttribute('height'))});
      this.write(shape,[label.x,label.y]);
    }else this.write(shape,this.sample(shape,at));
  }

  retarget(root:Element,at:number,scope='',automatic=true){
    if(scope!==this.scope){this.reset();this.scope=scope;}
    this.automatic=automatic;
    this.duration=this.previousAt===undefined?120:clamp(at-this.previousAt,80,120);
    this.previousAt=at;this.updates++;
    const alive=new Set<string>();
    for(const item of this.elements(root)){
      alive.add(item.key);
      const target=item.attributes.map(attribute=>Number(item.node.getAttribute('data-target-'+attribute)??item.node.getAttribute(attribute)));
      if(!target.every(Number.isFinite))continue;
      const previous=this.shapes.get(item.key);
      if(item.anchorKey){
        // A caption changes in place at the drawn box's corner. Its content
        // width must never launch a separate position/entrance animation.
        const shape={...item,from:target,to:target,start:at,duration:0};
        this.shapes.set(item.key,shape);this.drawShape(shape,at);
      }else if(previous&&previous.node===item.node){
        // Subpixel detector noise must not breathe a rectangle's size.
        const to=target.map((value,index)=>Math.abs(value-previous.to[index])<.5?previous.to[index]:value);
        const changed=to.some((value,index)=>value!==previous.to[index]);
        const shape=changed?{...item,from:this.sample(previous,at),to,start:at,duration:this.duration}:previous;
        this.shapes.set(item.key,shape);this.drawShape(shape,at);
      }else{
        this.shapes.set(item.key,{...item,from:target,to:target,start:at,duration:0});
      }
    }
    for(const key of this.shapes.keys())if(!alive.has(key))this.shapes.delete(key);
    this.play();
  }

  /** Resize/initial measurement can mount SVG nodes after the parent commit. */
  discover(root:Element,at:number){
    for(const item of this.elements(root)){
      const existing=this.shapes.get(item.key);
      const values=item.attributes.map(attribute=>Number(item.node.getAttribute('data-target-'+attribute)??item.node.getAttribute(attribute)));
      if(existing?.node===item.node&&values.every((value,index)=>Math.abs(value-existing.to[index])<.5))continue;
      if(values.every(Number.isFinite)){
        const shape={...item,from:values,to:values,start:at,duration:0};
        this.shapes.set(item.key,shape);this.drawShape(shape,at);
      }
    }
  }

  draw(at:number){
    let active=false;
    for(const [key,shape] of this.shapes){
      if(!shape.node.isConnected){this.shapes.delete(key);continue;}
      this.drawShape(shape,at);
      if(at<shape.start+shape.duration)active=true;
    }
    if(active)this.animatedFrames++;
    return active;
  }

  private play(){
    if(!this.automatic||this.frame!==undefined||typeof requestAnimationFrame!=='function')return;
    this.frame=requestAnimationFrame(at=>{
      this.frame=undefined;
      if(this.draw(at))this.play();
    });
  }

  reset(){
    if(this.frame!==undefined)cancelAnimationFrame(this.frame);
    this.frame=undefined;this.shapes.clear();this.previousAt=undefined;
  }
}
