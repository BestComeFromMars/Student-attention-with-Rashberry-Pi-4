import {describe,it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import AttentionList from './AttentionList';
import {DetectionHistory,vietnamDay} from '../lib/history';
import type {HistoryRun} from '../lib/history';
import type {ObservationSession,SessionSnapshot} from '../lib/session';

const base:SessionSnapshot={camera:'off',detection:'idle',tracks:[],error:null,devices:[],selectedDevice:'',cameraLabel:'',resolution:null,fps:0,startedAt:null};
const histories:DetectionHistory[]=[];
afterEach(()=>{cleanup();histories.splice(0).forEach(h=>h.dispose());vi.restoreAllMocks();});
function setup(){
  const date=vietnamDay(),now=Date.now();
  const run:HistoryRun={id:crypto.randomUUID(),date,number:1,startedAt:now-10000,endedAt:now-1000,source:'pi',cameraLabel:'Pi',peopleCount:1,eventCount:2,
    captures:[{captureId:crypto.randomUUID(),trackId:'A',displayName:'Minh Anh',labels:['Gục người'],count:2,firstAt:now-9000,lastAt:now-2000,revision:2,photoUrl:'/portrait.jpg'}]};
  let removed=false;
  const request=vi.fn(async(input:RequestInfo|URL,options?:RequestInit)=>{
    const path=String(input),method=options?.method??'GET';
    if(method==='DELETE'){removed=true;return new Response(null,{status:204});}
    if(method==='POST'){const data=JSON.parse(String(options!.body));return new Response(JSON.stringify({...data,date,number:2}),{status:201});}
    const result=path.endsWith('/days')?{days:removed?[]:[date]}:path.includes('/days/')?{runs:removed?[]:[run]}:run;
    return new Response(JSON.stringify(result),{status:200});
  }) as unknown as typeof fetch;
  const history=new DetectionHistory(request);histories.push(history);
  const session={history,reset:vi.fn(),rename:vi.fn()} as unknown as ObservationSession;
  return {history,session,request,run};
}
describe('persistent attention panel',()=>{
  it('opens the newest block and reads archived portraits and counts with the camera off',async()=>{
    const {history,session}=setup();render(<AttentionList state={base} session={session}/>);
    expect(await screen.findByRole('img',{name:/Ảnh Minh Anh/})).toBeDefined();
    expect(screen.getByText(/2 đợt cảnh báo/)).toBeDefined();
    expect((screen.getByLabelText('Ngày lịch sử') as HTMLInputElement).value).toBe(vietnamDay());
    const toggle=screen.getByRole('button',{name:/Lần 1/});fireEvent.click(toggle);
    expect(screen.queryByRole('img')).toBeNull();fireEvent.click(toggle);
    expect(await screen.findByRole('img')).toBeDefined();
    expect(history.getSnapshot().selectedId).toBeDefined();
  });
  it('confirms deletion and disables deletion of the current recording',async()=>{
    const {history,session,request,run}=setup();render(<AttentionList state={base} session={session}/>);
    await screen.findByRole('img');vi.spyOn(window,'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button',{name:'Xóa lần 1'}));expect(request).not.toHaveBeenCalledWith(expect.anything(),expect.objectContaining({method:'DELETE'}));
    vi.mocked(window.confirm).mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:'Xóa lần 1'}));
    await waitFor(()=>expect(screen.queryByRole('button',{name:/Lần 1/})).toBeNull());
    expect(request).toHaveBeenCalledWith('/api/history/runs/'+run.id,expect.objectContaining({method:'DELETE'}));
    history.begin('pi','Pi');await history.flush();
    await waitFor(()=>expect((screen.getByRole('button',{name:'Xóa lần 2'}) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole('button',{name:'Xóa lịch sử ngày đang xem'}) as HTMLButtonElement).disabled).toBe(true);
  });
});
