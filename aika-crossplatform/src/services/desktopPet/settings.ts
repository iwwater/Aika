import { SETTING_KEYS } from "../storage/contracts";
import type { SettingsStore } from "../storage/settingsStore";
import { PET_CONFIG_DEFAULTS, normalizePetConfig, type PetConfig } from "./contracts";
import { validatePetProfile, type PetProfileV1 } from "./profile";

/**
 * 外部桌宠的配置与 profile 持久化（PET-06）。
 *
 * 两条规则直接沿用 `settingsStore` 的既定语义，不另造一套：
 *
 * 1. **读到坏值回落默认值，绝不把坏值写回**。损坏的 endpoint 或 profile 等价于
 *    「还没配」——界面显示默认值，用户改一次就覆盖掉。
 * 2. **首次默认关闭**。`PET_CONFIG_DEFAULTS.enabled === false`，旧的
 *    `pet.windowEnabled`（自研桌宠窗口）**不会**被转换成这里的托管启动授权。
 */

export interface DesktopPetSettingsStore {
  read(): Promise<{ config: PetConfig; profile: PetProfileV1 | null }>;
  readConfig(): Promise<PetConfig>;
  writeConfig(config: PetConfig): Promise<void>;
  readProfile(): Promise<PetProfileV1 | null>;
  writeProfile(profile: PetProfileV1 | null): Promise<void>;
  /** 集成是否已启用（供旧自研桌宠判断是否让位）。 */
  isEnabled(): Promise<boolean>;
}

export function createDesktopPetSettings(
  settings: Pick<SettingsStore, "getJson" | "setJson">,
): DesktopPetSettingsStore {
  return {
    readConfig: () => settings.getJson<PetConfig>(
      SETTING_KEYS.desktopPet,
      { ...PET_CONFIG_DEFAULTS },
      (raw) => normalizePetConfig(raw),
    ),

    readProfile: () => settings.getJson<PetProfileV1 | null>(
      SETTING_KEYS.desktopPetProfile,
      null,
      (raw) => (raw === null ? null : validatePetProfile(raw)),
    ),

    async read() {
      const [config, profile] = await Promise.all([
        settings.getJson<PetConfig>(
          SETTING_KEYS.desktopPet,
          { ...PET_CONFIG_DEFAULTS },
          (raw) => normalizePetConfig(raw),
        ),
        settings.getJson<PetProfileV1 | null>(
          SETTING_KEYS.desktopPetProfile,
          null,
          (raw) => (raw === null ? null : validatePetProfile(raw)),
        ),
      ]);
      return { config, profile };
    },

    writeConfig: (config) => settings.setJson(SETTING_KEYS.desktopPet, normalizePetConfig(config)),

    writeProfile: (profile) => settings.setJson(
      SETTING_KEYS.desktopPetProfile,
      profile === null ? null : validatePetProfile(profile),
    ),

    async isEnabled() {
      const config = await settings.getJson<PetConfig>(
        SETTING_KEYS.desktopPet,
        { ...PET_CONFIG_DEFAULTS },
        (raw) => normalizePetConfig(raw),
      );
      return config.enabled;
    },
  };
}
