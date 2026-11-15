import {describe,it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import AttentionList from './AttentionList';
import type {ObservationSession,SessionSnapshot} from '../lib/session';
const base:SessionSnapshot={camera:'on',detection:'running',tracks:[],error:null,devices:[],selectedDevice:'',cameraLabel:'',resolution:null,fps:0,startedAt:null};
afterEach(cleanup);
describe('attention captures panel',()=>{
  it('shows captured faces, visible behavior, time and an explicit missing-face placeholder',()=>{
    const captures=[{id:'A',displayName:'Học sinh A',labels:['Quay lệch hướng lâu'],photo:'data:image/jpeg;base64,test',firstAt:1000,lastAt:2000,count:1},
      {id:'B',displayName:'Học sinh B',labels:['Có dấu hiệu gục đầu/thân trên'],firstAt:1000,lastAt:3000,count:2}];
    render(<AttentionList state={{...base,captures}} session={{} as ObservationSession}/>);
    expect(screen.getByRole('img',{name:/Ảnh mặt Học sinh A/})).toBeDefined();
    expect(screen.getByText('Chưa chụp được mặt')).toBeDefined();expect(screen.getByText('Quay lệch hướng lâu')).toBeDefined();
    expect(screen.queryByRole('heading',{name:'Cần chú ý'})).toBeNull();
  });
  it('clears records independently of camera/reset and preserves renaming',()=>{
    const clearCaptures=vi.fn(),reset=vi.fn(),rename=vi.fn();
    render(<AttentionList state={{...base,captures:[{id:'A',displayName:'Học sinh A',labels:['Quay lệch hướng lâu'],firstAt:1000,lastAt:2000,count:1}]}}
      session={{clearCaptures,reset,rename} as unknown as ObservationSession}/>);
    fireEvent.click(screen.getByRole('button',{name:'Đổi tên Học sinh A'}));
    const input=screen.getByRole('textbox',{name:'Tên học sinh A'});fireEvent.change(input,{target:{value:'Minh Anh'}});fireEvent.blur(input);
    expect(rename).toHaveBeenCalledWith('A','Minh Anh');
    fireEvent.click(screen.getByRole('button',{name:'Xóa danh sách cần chú ý'}));expect(clearCaptures).toHaveBeenCalledOnce();expect(reset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Đặt lại phiên nhận diện'}));expect(reset).toHaveBeenCalledOnce();
  });
});
