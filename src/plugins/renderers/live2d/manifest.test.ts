import { describe, expect, it } from 'vitest';
import { PET_ACTION_ANIMATION_IDS, PET_POSE_ANIMATION_IDS } from '../../../pet/animation';
import { LIVE2D_APPEARANCES } from './catalog';
import { parseLive2dManifest, playableActionIds, resolveLive2dAction } from './manifest';

/**
 * MVP-11 定向测试：动作映射与「不假装播放」。
 *
 * 这一层之所以必须存在，是因为 PET-07 的实机核对证明引擎对不存在的 motion
 * group / index **不抛错**——它静默受理。所以「这个动作能不能播」必须在调用前
 * 由 manifest 判定，而下面的 fixture 就是那两个官方模型 manifest 的结构事实。
 */

const motion = (name: string) => ({ File: `motions/${name}.motion3.json` });

/** Samples/Resources/Hiyori/Hiyori.model3.json：Idle 9 段、TapBody 1 段、无表情。 */
const HIYORI_MANIFEST = {
  Version: 3,
  FileReferences: {
    Moc: 'Hiyori.moc3',
    Textures: ['Hiyori.2048/texture_00.png', 'Hiyori.2048/texture_01.png'],
    Physics: 'Hiyori.physics3.json',
    Pose: 'Hiyori.pose3.json',
    UserData: 'Hiyori.userdata3.json',
    DisplayInfo: 'Hiyori.cdi3.json',
    Motions: {
      Idle: Array.from({ length: 9 }, (_, index) => motion(`Hiyori_m0${index + 1}`)),
      TapBody: [motion('Hiyori_m04')],
    },
  },
  Groups: [
    { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
    { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
  ],
  HitAreas: [{ Id: 'HitArea', Name: 'Body' }],
};

/** Samples/Resources/Mao/Mao.model3.json：Idle 2 段、TapBody 6 段、表情 exp_01-08。 */
const MAO_MANIFEST = {
  Version: 3,
  FileReferences: {
    Moc: 'Mao.moc3',
    Textures: ['Mao.2048/texture_00.png'],
    Physics: 'Mao.physics3.json',
    Pose: 'Mao.pose3.json',
    DisplayInfo: 'Mao.cdi3.json',
    Expressions: Array.from({ length: 8 }, (_, index) => ({
      Name: `exp_0${index + 1}`,
      File: `expressions/exp_0${index + 1}.exp3.json`,
    })),
    Motions: {
      Idle: [motion('mtn_01'), motion('sample_01')],
      TapBody: ['mtn_02', 'mtn_03', 'mtn_04', 'special_01', 'special_02', 'special_03'].map(motion),
    },
  },
  Groups: [
    { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamA'] },
    { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
  ],
  HitAreas: [
    { Id: 'HitAreaHead', Name: 'Head' },
    { Id: 'HitAreaBody', Name: 'Body' },
  ],
};

const HIYORI = parseLive2dManifest(HIYORI_MANIFEST);
const MAO = parseLive2dManifest(MAO_MANIFEST);

describe('manifest 解析', () => {
  it('读出 motion 组数量、表情、hit area 与 LipSync 参数', () => {
    expect(HIYORI).not.toBeNull();
    expect(HIYORI?.motionGroups).toEqual({ Idle: 9, TapBody: 1 });
    expect(HIYORI?.expressions).toEqual([]);
    expect(HIYORI?.hitAreas).toEqual(['Body']);
    expect(HIYORI?.lipSyncParameters).toEqual(['ParamMouthOpenY']);

    expect(MAO?.motionGroups).toEqual({ Idle: 2, TapBody: 6 });
    expect(MAO?.expressions).toEqual([
      'exp_01', 'exp_02', 'exp_03', 'exp_04', 'exp_05', 'exp_06', 'exp_07', 'exp_08',
    ]);
    expect(MAO?.hitAreas).toEqual(['Head', 'Body']);
  });

  it('坏 manifest 返回 null 而不是抛错', () => {
    for (const bad of [null, undefined, 'nope', 42, [], {}, { Version: 2 }]) {
      expect(parseLive2dManifest(bad)).toBeNull();
    }
    // Version 对但没有 FileReferences：同样视为坏模型。
    expect(parseLive2dManifest({ Version: 3 })).toBeNull();
    // 只有 FileReferences 没有 Motions/Expressions 仍可用：动作全不可播，但模型能加载。
    expect(parseLive2dManifest({ Version: 3, FileReferences: {} })?.motionGroups).toEqual({});
  });
});

describe('动作解析：未知项确定降级', () => {
  it('组存在且 index 在范围内才解析成功', () => {
    expect(resolveLive2dAction({ kind: 'motion', group: 'Idle', index: 0 }, HIYORI))
      .toEqual({ kind: 'motion', group: 'Idle', index: 0 });
    expect(resolveLive2dAction({ kind: 'motion', group: 'Idle', index: 8 }, HIYORI)).not.toBeNull();
  });

  it('不存在的 group 解析为 null（引擎不会报错，所以只能在这里挡）', () => {
    expect(resolveLive2dAction({ kind: 'motion', group: 'Tap', index: 0 }, HIYORI)).toBeNull();
    expect(resolveLive2dAction({ kind: 'motion', group: 'idle', index: 0 }, HIYORI)).toBeNull();
  });

  it('index 越界或非整数解析为 null', () => {
    // Hiyori Idle 只有 9 段：index 9 越界。这正是「引擎静默受理」的那一类。
    expect(resolveLive2dAction({ kind: 'motion', group: 'Idle', index: 9 }, HIYORI)).toBeNull();
    expect(resolveLive2dAction({ kind: 'motion', group: 'Idle', index: -1 }, HIYORI)).toBeNull();
    expect(resolveLive2dAction({ kind: 'motion', group: 'Idle', index: 1.5 }, HIYORI)).toBeNull();
    // 同一份映射换个模型就可能越界：Mao 的 Idle 只有 2 段。
    expect(resolveLive2dAction({ kind: 'motion', group: 'Idle', index: 5 }, MAO)).toBeNull();
  });

  it('表情名必须在清单里', () => {
    expect(resolveLive2dAction({ kind: 'expression', name: 'exp_02' }, MAO))
      .toEqual({ kind: 'expression', name: 'exp_02' });
    expect(resolveLive2dAction({ kind: 'expression', name: 'exp_99' }, MAO)).toBeNull();
    // Hiyori 没有表情：表情映射在它上面一律不可播。
    expect(resolveLive2dAction({ kind: 'expression', name: 'exp_02' }, HIYORI)).toBeNull();
  });

  it('没有映射或没有 manifest 时一律 null', () => {
    expect(resolveLive2dAction(undefined, HIYORI)).toBeNull();
    expect(resolveLive2dAction({ kind: 'motion', group: 'Idle', index: 0 }, null)).toBeNull();
  });
});

describe('外观目录与 manifest 的一致性', () => {
  const manifests: Record<string, ReturnType<typeof parseLive2dManifest>> = {
    hiyori: HIYORI,
    mao: MAO,
  };

  it('每套外观都覆盖全部运行期动作 id，且在对应 manifest 上确实可播', () => {
    for (const appearance of LIVE2D_APPEARANCES) {
      const manifest = manifests[appearance.id] ?? null;
      expect(manifest, `${appearance.id} 缺少 fixture`).not.toBeNull();
      // 目录里出现 manifest 之外的动作 id：说明表写错了，不是模型不支持。
      const playable = playableActionIds(appearance.actions, manifest);
      const declared = Object.keys(appearance.actions).sort();
      expect(playable, `${appearance.id} 有无法播放的声明映射`).toEqual(declared);
      for (const id of PET_ACTION_ANIMATION_IDS) {
        expect(appearance.actions[id], `${appearance.id} 缺少 ${id}`).toBeDefined();
      }
    }
  });

  it('目录不会声明运行期动作/姿态 id 之外的键', () => {
    // 六个动作走 action()，`idle` 走 pose()；两者都必须来自共享常量，
    // 不许目录自己发明一个 id。
    const known = [...PET_ACTION_ANIMATION_IDS, ...PET_POSE_ANIMATION_IDS] as readonly string[];
    for (const appearance of LIVE2D_APPEARANCES) {
      for (const id of Object.keys(appearance.actions)) {
        expect(known, `${appearance.id} 声明了未知 id ${id}`).toContain(id);
      }
    }
  });
});
