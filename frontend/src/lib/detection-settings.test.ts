import {afterEach,describe,it,expect} from 'vitest';
import {DETECTION_SETTINGS_KEY,normalizeDetectionSettings,readDetectionSettings,saveDetectionSettings} from './detection-settings';
const legacy='student-attention.observation-settings.v1';
const previous='student-attention.observation-settings.v2';
const v3='student-attention.observation-settings.v3';
afterEach(()=>{localStorage.removeItem(legacy);localStorage.removeItem(previous);localStorage.removeItem(v3);localStorage.removeItem(DETECTION_SETTINGS_KEY);});
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
  it('temporarily switches phone alerts off once and preserves subsequent opt-in and other settings',()=>{
    localStorage.setItem(previous,JSON.stringify({enabled:{phone:true,talking:false},thresholds:{phoneMs:900,headTurnAngleDeg:25}}));
    const migrated=readDetectionSettings()!;
    expect(migrated).toEqual({enabled:{phone:false,talking:false},thresholds:{phoneMs:900,headTurnAngleDeg:25}});
    migrated.enabled.phone=true;saveDetectionSettings(migrated);
    expect(readDetectionSettings()?.enabled.phone).toBe(true);
  });
  it('migrates v3 to v4 with RAM-light objectsEnabled=false and normalizes schema defaults',()=>{
    localStorage.setItem(v3,JSON.stringify({enabled:{phone:true,laptop:true,talking:true},thresholds:{headDownPitchDeg:20}}));
    const migrated=readDetectionSettings()!;
    expect(migrated.objectsEnabled).toBe(false);
    expect(migrated.enabled.phone).toBe(false);
    expect(migrated.enabled.laptop).toBe(false);
    expect(migrated.enabled.talking).toBe(true);
    const normalized=normalizeDetectionSettings({
      defaults:{objectsEnabled:false,enabled:{talking:true,laptop:false},thresholds:{headDownPitchDeg:18}},
      behaviors:[{id:'talking',label:'Nói',description:''},{id:'laptop',label:'Laptop',description:''}],
      fields:[{key:'headDownPitchDeg',group:'head_down',label:'Góc',value:18,min:5,max:60,step:1,scale:1,unit:'°'}],
    },migrated);
    expect(normalized).toEqual({objectsEnabled:false,enabled:{talking:true,laptop:false},thresholds:{headDownPitchDeg:20}});
  });
});
