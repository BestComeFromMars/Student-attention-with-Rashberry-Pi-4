import { describe, expect, it } from 'vitest';
import { statusAppearance, STATUS_KEYS } from './attention';

describe('recent warning appearance', () => {
  it('only displays observation and warning states, including legacy focus payloads', () => {
    expect(STATUS_KEYS).toEqual(['uncertain','needs_attention']);
    expect(statusAppearance({attention:'focused'}).label).toBe('AI đang quan sát');
    expect(statusAppearance({attention:'uncertain'}).label).toBe('AI đang quan sát');
  });
  it('keeps a confirmed warning red through a missed face and explicitly labels the loss', () => {
    const appearance = statusAppearance({attention:'needs_attention',status:'lost',alerts:[{
      type:'phone',label:'Cầm điện thoại',held:true,observedAt:800,expiresAt:5800,
    }]});
    expect(appearance.color).toBe('#ef4444');
    expect(appearance.label).toContain('tạm mất dấu');
  });
  it('uses yellow for a lost track without a retained warning', () => {
    expect(statusAppearance({attention:'focused',status:'lost'}).color).toBe('#eab308');
    expect(statusAppearance({attention:'needs_attention',status:'lost',alerts:[]}).color).toBe('#eab308');
  });
});
