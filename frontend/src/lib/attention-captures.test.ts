import {describe,it,expect,vi,afterEach} from 'vitest';
import {AttentionCaptures,captureFace,CAPTURE_LIMIT} from './attention-captures';
import type {StudentTrack} from './types';
const frame={width:1000,height:500} as HTMLCanvasElement;
const person=(at:number,warning=true):StudentTrack=>({id:'A',displayName:'Học sinh A',personId:7,geometryId:9,color:'',lastSeen:at,status:'visible',trackingState:'face',
  boxKind:'person',box:{x:.1,y:.1,width:.4,height:.8},personBox:{x:.1,y:.1,width:.4,height:.8},
  faceBox:{x:.2,y:.2,width:.1,height:.2},faceVisibility:'visible',attention:warning?'needs_attention':'uncertain',
  alerts:warning?[{type:'head_turned',label:'Quay lệch hướng lâu',observedAt:at,expiresAt:at+5000,held:false}]:[]});
afterEach(()=>vi.restoreAllMocks());
describe('attention face snapshots',()=>{
  it('counts episodes rather than repeated frames, changed labels, held labels or temporarily missing faces',()=>{
    const changes=vi.fn(),store=new AttentionCaptures(()=> 'data:image/jpeg;base64,one',changes);
    expect(store.update([person(1000)],frame,1000,10000)[0].count).toBe(1);
    const changed=person(1500);changed.alerts![0].label='Dấu hiệu khác';changed.alerts![0].type='head_down';
    expect(store.update([changed],frame,1500,10500)[0].count).toBe(1);
    store.update([],null,2000,11000);
    store.update([{...person(2500,false),faceVisibility:'unavailable'}],null,2500,11500);
    expect(store.update([person(3000)],frame,3000,12000)[0].count).toBe(1);
    store.update([person(3500,false)],frame,3500,12500);
    expect(store.update([person(4000)],frame,4000,13000)[0].count).toBe(2);
  });
  it('refreshes the most recent warning portrait without incrementing count',()=>{
    let image='first';const changed=vi.fn(),store=new AttentionCaptures(()=>image,changed);
    const first=store.update([person(1000)],frame,1000,10000)[0];
    image='latest';const next=store.update([person(2200)],frame,2200,11200)[0];
    expect(next).toMatchObject({photo:'latest',count:1,captureId:first.captureId,lastAt:11200});
    expect(next.revision!).toBeGreaterThan(first.revision!);
    expect(changed.mock.calls.at(-1)![0].photo).toBe('latest');
  });
  it('archives every person before the 40-image cache evicts them, with separate identities for reused IDs',()=>{
    const changed=vi.fn(),store=new AttentionCaptures(()=> 'jpeg',changed);
    for(let i=0;i<45;i++)store.update([{...person(i*1000),id:String(i),personId:i}],frame,i*1000,i*1000);
    expect(store.snapshot()).toHaveLength(40);expect(changed.mock.calls.filter(c=>c[0].count===1)).toHaveLength(45);
    const a=new AttentionCaptures(()=> 'jpeg',changed);
    const first=a.update([person(1000)],frame,1000)[0];
    const second=a.update([{...person(1200),personId:8}],frame,1200)[0];
    expect(first.captureId).not.toBe(second.captureId);
    a.setPortrait(person(1300),'late old face',1300,13000,first.captureId!);
    expect(a.snapshot()[0].photo).not.toBe('late old face');
  });
  it('records only new confirmed warnings and keeps the original image through continuous replies',()=>{
    const crop=vi.fn(()=> 'data:image/jpeg;base64,test'),store=new AttentionCaptures(crop);
    expect(store.update([person(1000,false)],frame,1000)).toEqual([]);
    const first=store.update([person(1200)],frame,1200,10000)[0];
    expect(first).toMatchObject({id:'A',count:1,photo:'data:image/jpeg;base64,test',lastAt:10000});
    const next=store.update([person(1400)],frame,1400,10200)[0];expect(next.count).toBe(1);expect(next.lastAt).toBe(10000);
    const held=person(1600);held.alerts![0].held=true;
    expect(store.update([held],frame,1600,10400)[0].count).toBe(1);
  });
  it('does not take a face from an unpaired frame and marks a briefly cached face as older',()=>{
    const crop=vi.fn((_frame,track)=>track.faceVisibility==='unavailable'?undefined:'data:image/jpeg;base64,face');
    const store=new AttentionCaptures(crop);store.update([person(1000,false)],frame,1000,10000);
    const hidden={...person(1500),faceVisibility:'unavailable' as const,faceBox:undefined};
    const result=store.update([hidden],null,1500,10500)[0];
    expect(result.photo).toBeDefined();expect(result.photoBeforeAlert).toBe(true);expect(result.photoAt).toBe(10000);
    const unknown=new AttentionCaptures(crop).update([hidden],null,1500,10500)[0];expect(unknown.photo).toBeUndefined();
    const stale=new AttentionCaptures(crop);stale.update([person(1000,false)],frame,1000,10000);
    expect(stale.update([hidden],null,4000,13000)[0].photo).toBeUndefined();
  });
  it('captures the face when it becomes visible during a continuing alert',()=>{
    const store=new AttentionCaptures((_frame,track)=>track.faceVisibility==='unavailable'?undefined:'data:image/jpeg;base64,new');
    store.update([{...person(1000),faceVisibility:'unavailable',faceBox:undefined}],frame,1000);
    expect(store.update([person(1300)],frame,1300)[0]).toMatchObject({photo:'data:image/jpeg;base64,new',count:1});
  });
  it('does not transfer photos to a different person reusing the same display ID',()=>{
    const store=new AttentionCaptures(()=> 'data:image/jpeg;base64,old');store.update([person(1000)],frame,1000);
    const replacement={...person(1300),personId:8,faceVisibility:'unavailable' as const,faceBox:undefined};
    const result=store.update([replacement],null,1300)[0];expect(result.photo).toBeUndefined();expect(result.personId).toBe(8);expect(result.count).toBe(1);
  });
  it('clears images without recreating a still-continuous warning, and fully resets between sessions',()=>{
    const store=new AttentionCaptures(()=> 'data:image/jpeg;base64,test');store.update([person(1000)],frame,1000);
    store.clearRecords();expect(store.update([person(1200)],frame,1200)).toEqual([]);
    store.update([person(1400,false)],frame,1400);expect(store.update([person(1600)],frame,1600)).toHaveLength(1);
    store.clear();expect(store.update([],null,1800)).toEqual([]);
    expect(store.update([person(2000)],null,2000)[0].photo).toBeUndefined();
  });
  it('bounds the number of portraits, sorts by event time and supports renaming',()=>{
    const store=new AttentionCaptures(()=> 'data:image/jpeg;base64,test');let result;
    for(let n=0;n<CAPTURE_LIMIT+5;n++)result=store.update([{...person(1000+n*100),id:String(n),personId:n}],frame,1000+n*100,10000+n*100);
    expect(result).toHaveLength(CAPTURE_LIMIT);expect(result![0].id).toBe(String(CAPTURE_LIMIT+4));
    expect(store.rename(result![0].id,'Minh Anh')[0].displayName).toBe('Minh Anh');
  });
  it('crops the raw face rectangle instead of a body or smoothed display rectangle',()=>{
    const drawImage=vi.fn();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage} as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/jpeg;base64,test');
    const track=person(1000);track.displayBoxes={face:{x:.8,y:.8,width:.1,height:.1}};
    expect(captureFace(frame,track)).toBe('data:image/jpeg;base64,test');
    expect(drawImage.mock.calls[0][0]).toBe(frame);
    for(const [index,value]of [190,90,120,120,0,0,160,160].entries())expect(drawImage.mock.calls[0][index+1]).toBeCloseTo(value,8);
    expect(captureFace(frame,{...track,faceVisibility:'unavailable'})).toBeUndefined();
    expect(captureFace(frame,{...track,trackingState:'body'})).toBeUndefined();
    expect(captureFace(frame,{...track,faceBox:undefined})).toBeUndefined();
  });
});
