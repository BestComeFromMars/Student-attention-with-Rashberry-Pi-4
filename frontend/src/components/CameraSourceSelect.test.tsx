import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import CameraSourceSelect from './CameraSourceSelect';

afterEach(cleanup);
describe('camera source dropdown', () => {
  it('offers manual refresh outside the device list without scanning on open', () => {
    const discover=vi.fn(),change=vi.fn();
    const {rerender}=render(<CameraSourceSelect value="raspberry-pi" disabled={false} computerReady piReady={false}
      devices={[{deviceId:'',label:''}]} onDiscover={discover} onChange={change}/>);
    fireEvent.click(screen.getByRole('combobox'));
    expect(discover).not.toHaveBeenCalled();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    const button=screen.getByRole('button',{name:'Làm mới danh sách'});
    expect(within(screen.getByRole('listbox')).queryByRole('button',{name:'Làm mới danh sách'})).toBeNull();
    fireEvent.click(button);expect(discover).toHaveBeenCalledOnce();expect(change).not.toHaveBeenCalled();
    rerender(<CameraSourceSelect value="raspberry-pi" disabled={false} computerReady piReady={false}
      devices={[{deviceId:'usb',label:'USB Camera'}]} onDiscover={discover} onChange={change}/>);
    expect(screen.getByRole('option',{name:/USB Camera/})).toBeDefined();
    expect(screen.getByRole('button',{name:'Làm mới danh sách'})).toBeDefined();
  });
  it('lists integrated, USB and virtual cameras, selects exact IDs and updates on unplug', () => {
    const change=vi.fn();
    const devices=[{deviceId:'integrated',label:'Integrated Camera'},{deviceId:'usb',label:'USB Camera'},
      {deviceId:'virtual',label:'OBS Virtual Camera'}];
    const {rerender}=render(<CameraSourceSelect value="usb" disabled={false} computerReady piReady={false} devices={devices} onChange={change}/>);
    expect(within(screen.getByRole('combobox')).getByText('USB Camera')).toBeDefined();
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getAllByRole('option')).toHaveLength(5);
    fireEvent.click(screen.getByRole('option',{name:/Integrated Camera/}));
    expect(change).toHaveBeenLastCalledWith('integrated');
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.keyDown(screen.getByRole('combobox'),{key:'ArrowUp'});
    fireEvent.keyDown(screen.getByRole('combobox'),{key:'Enter'});
    expect(change).toHaveBeenLastCalledWith('integrated');
    rerender(<CameraSourceSelect value="integrated" disabled={false} computerReady piReady={false} devices={[devices[0],devices[2]]} onChange={change}/>);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('option',{name:/USB Camera/})).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });
  it('shows selected-source readiness without opening the field and keeps badges in both choices', () => {
    const change = vi.fn();
    render(<CameraSourceSelect value="" disabled={false} computerReady piReady={false} onChange={change} />);
    expect(within(screen.getByRole('combobox')).getByText('Sẵn sàng')).toBeDefined();
    fireEvent.click(screen.getByRole('combobox', { name: 'Chọn webcam' }));
    const pc = screen.getByRole('option', { name: /Webcam máy tính/ });
    const pi = screen.getByRole('option', { name: /Raspberry Pi 4/ });
    expect(within(pc).getByText('Sẵn sàng').className).toContain('camera-status-ready');
    expect(within(pi).getByText('Chưa tìm thấy').className).toContain('camera-status-missing');
    fireEvent.click(pi);
    expect(change).toHaveBeenCalledExactlyOnceWith('raspberry-pi');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('supports keyboard selection, escape and closing outside without changing the source', () => {
    const change = vi.fn();
    render(<CameraSourceSelect value="" disabled={false} computerReady piReady onChange={change} />);
    const trigger = screen.getByRole('combobox', { name: 'Chọn webcam' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(change).toHaveBeenCalledExactlyOnceWith('raspberry-pi');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(change).toHaveBeenCalledTimes(1);
  });
});
