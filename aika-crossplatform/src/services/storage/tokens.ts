import { token } from "../../kernel";
import type { AikaStorage } from "./contracts";
import type { SecretStore } from "./secretStore";
import type { SettingsStore } from "./settingsStore";

/**
 * 存储相关的服务标识。
 *
 * token 定义在它描述的接口旁边，不进任何汇总清单——有中央清单，
 * 「新增一种能力」就等于「改内核」。
 */

export const StorageToken = token<AikaStorage>("storage.aika");
export const SecretStoreToken = token<SecretStore>("storage.secrets");
export const SettingsToken = token<SettingsStore>("storage.settings");
