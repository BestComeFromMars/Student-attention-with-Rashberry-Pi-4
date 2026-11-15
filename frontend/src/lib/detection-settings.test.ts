import {afterEach,describe,it,expect} from 'vitest';
import {DETECTION_SETTINGS_KEY,readDetectionSettings,saveDetectionSettings} from './detection-settings';
const legacy='student-attention.observation-settings.v1';
afterEach(()=>{localStorage.removeItem(legacy);localStorage.removeItem(DETECTION_SETTINGS_KEY);});
describe('less sensitive neck-turn default migration',()=>{
  it('upgrades the former default once and retains other settings',()=>{
    localStorage.setItem(legacy,JSON.stringify({enabled:{phone:false},thresholds:{headTurnAngleDeg:25,phoneMs:900}}));
    expect(readDetectionSettings()).toEqual({enabled:{phone:false},thresholds:{headTurnAngleDeg:35,phoneMs:900}});
    expect(localStorage.getItem(DETECTION_SETTINGS_KEY)).not.toBeNull();
  });
  it('keeps a previously customized angle',()=>{
    localStorage.setItem(legacy,JSON.stringify({enabled:{},thresholds:{headTurnAngleDeg:45}}));
    expect(readDetectionSettings()?.thresholds.headTurnAngleDeg).toBe(45);
  });
  it('retains an explicit angle adjustment made after upgrading',()=>{
    saveDetectionSettings({enabled:{},thresholds:{headTurnAngleDeg:25}});
    expect(readDetectionSettings()?.thresholds.headTurnAngleDeg).toBe(25);
  });
});
