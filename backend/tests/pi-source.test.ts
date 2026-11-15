import {afterEach,describe,expect,it,vi} from 'vitest';
import sharp from 'sharp';
import {PiSource} from '../src/pi-source.js';

vi.mock('sharp',()=>({default:vi.fn()}));
afterEach(()=>vi.resetAllMocks());

describe('latest camera frame',()=>{
  it('discards an older upload whose validation completes after the newer frame',async()=>{
    let validateOlder!:()=>void;
    const olderValidation=new Promise<void>(resolve=>{validateOlder=resolve;});
    vi.mocked(sharp).mockImplementationOnce(()=>({metadata:async()=>({format:'jpeg',width:320,height:240}),stats:()=>olderValidation}) as never)
      .mockImplementationOnce(()=>({metadata:async()=>({format:'jpeg',width:640,height:480}),stats:async()=>({})}) as never);
    const pi=new PiSource(),older=pi.update(Buffer.from('older'));
    await pi.update(Buffer.from('newer'));
    validateOlder();await older;
    expect(pi.frame().toString()).toBe('newer');
    expect(pi.status()).toMatchObject({width:640,height:480});pi.close();
  });
  it('does not resurrect a stopped source when pending validation completes',async()=>{
    let validate!:()=>void;
    const validation=new Promise<void>(resolve=>{validate=resolve;});
    vi.mocked(sharp).mockImplementation(()=>({metadata:async()=>({format:'jpeg',width:320,height:240}),stats:()=>validation}) as never);
    const pi=new PiSource(),updating=pi.update(Buffer.from('frame'));
    pi.close();validate();await updating;
    expect(pi.status().online).toBe(false);expect(()=>pi.frame()).toThrow();
  });
});
