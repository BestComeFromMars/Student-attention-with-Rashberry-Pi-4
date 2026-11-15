import {afterEach,describe,expect,it} from 'vitest';
import {OverlayMotion} from './overlay-motion';

function fixture(){
  const root=document.createElement('div');
  root.innerHTML='<svg><g data-person-id="A"><rect class="person-frame" x="0" y="10" width="50" height="80"/></g></svg>';
  document.body.append(root);
  const rect=root.querySelector('rect')!,motion=new OverlayMotion();
  const target=(x:number,width=50)=>{
    for(const [key,value] of Object.entries({x,y:10,width,height:80})){
      rect.setAttribute(key,String(value));rect.setAttribute('data-target-'+key,String(value));
    }
  };
  return {root,rect,motion,target,x:()=>Number(rect.getAttribute('x'))};
}
afterEach(()=>document.body.replaceChildren());

describe('SVG motion independent of AI cadence',()=>{
  it('moves a single rectangle at every source frame between slow completed AI results',()=>{
    const {root,rect,motion,target,x}=fixture();
    motion.retarget(root,0,'camera',false);target(90);motion.retarget(root,900,'camera',false);
    const positions:number[]=[];
    for(let frame=0;frame<=4;frame++){motion.draw(900+frame*1000/30);positions.push(x());}
    expect(new Set(positions).size).toBe(5);
    expect(positions[0]).toBe(0);expect(positions.at(-1)).toBe(90);
    expect(Math.max(...positions.slice(1).map((p,index)=>p-positions[index]))).toBeCloseTo(25);
    expect(rect.getAttribute('width')).toBe('50');
    expect(root.querySelectorAll('rect')).toHaveLength(1);
  });
  it('continues from the drawn location when a new AI target arrives mid-animation',()=>{
    const {root,motion,target,x}=fixture();motion.retarget(root,0,'',false);
    target(90);motion.retarget(root,900,'',false);motion.draw(960);expect(x()).toBe(45);
    target(30);motion.retarget(root,960,'',false);expect(x()).toBe(45);
    motion.draw(1000);expect(x()).toBeCloseTo(37.5);
    motion.draw(1040);expect(x()).toBe(30);motion.draw(9000);expect(x()).toBe(30);
  });
  it('does not reinterpret its animated DOM coordinates as a new model target',()=>{
    const {root,rect,motion,target,x}=fixture();motion.retarget(root,0,'',false);
    target(90);motion.retarget(root,900,'',false);motion.draw(940);expect(x()).toBe(30);
    // React need not write x again when the next raw AI x is unchanged.
    motion.retarget(root,950,'',false);motion.draw(1020);expect(x()).toBe(90);
    expect(rect.getAttribute('data-target-x')).toBe('90');
  });
  it('ignores subpixel size jitter and resets immediately on a source change',()=>{
    const {root,rect,motion,target,x}=fixture();motion.retarget(root,0,'one',false);
    target(0,50.3);motion.retarget(root,500,'one',false);motion.draw(1000);
    expect(rect.getAttribute('width')).toBe('50');
    target(300);motion.retarget(root,1100,'two',false);expect(x()).toBe(300);
    root.replaceChildren();motion.retarget(root,1200,'two',false);motion.draw(5000);
    expect(root.querySelectorAll('rect')).toHaveLength(0);
  });
  it('changes a caption in place at the drawn corner instead of flying from its previous text width',()=>{
    const {root,rect,motion,target}=fixture();
    root.querySelector('svg')!.setAttribute('width','1000');root.querySelector('svg')!.setAttribute('height','600');
    root.querySelector('svg')!.insertAdjacentHTML('beforeend','<g data-person-label="A"><svg class="observation-label" data-anchor-frame="person:A" x="22" y="10" width="28" height="25"/></g>');
    const label=root.querySelector('.observation-label')!;
    motion.retarget(root,0,'camera',false);
    // A warning makes the caption much wider while the body moves and resizes.
    target(90,100);label.setAttribute('width','130');label.setAttribute('data-target-x','60');
    motion.retarget(root,900,'camera',false);
    expect(Number(label.getAttribute('x'))).toBe(0);
    for(const at of [900,930,960,990,1020]){
      motion.draw(at);
      const right=Number(rect.getAttribute('x'))+Number(rect.getAttribute('width'));
      expect(Number(label.getAttribute('x'))).toBeCloseTo(Math.max(0,right-130));
      expect(Number(label.getAttribute('y'))).toBe(10);
    }
    expect(Number(label.getAttribute('x'))).toBe(60);
    label.setAttribute('width','28');label.setAttribute('data-target-x','162');
    motion.retarget(root,1100,'camera',false);
    expect(Number(label.getAttribute('x')),'shorter text is aligned immediately').toBe(162);
  });
  it('discovers a new caption at the current box corner during an existing motion',()=>{
    const {root,rect,motion,target}=fixture();
    const svg=root.querySelector('svg')!;svg.setAttribute('width','1000');svg.setAttribute('height','600');
    motion.retarget(root,0,'camera',false);target(90);motion.retarget(root,900,'camera',false);
    svg.insertAdjacentHTML('beforeend','<g data-person-label="A"><svg class="observation-label" data-anchor-frame="person:A" x="112" y="10" width="28" height="25"/></g>');
    motion.discover(root,960);
    const label=root.querySelector('.observation-label')!;
    expect(Number(label.getAttribute('x'))).toBe(67);
    motion.draw(990);
    expect(Number(label.getAttribute('x'))+28).toBeCloseTo(Number(rect.getAttribute('x'))+50);
  });
});
