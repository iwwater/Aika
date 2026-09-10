import { token, type AikaPlugin } from "../../kernel";

/**
 * 扩展点示例插件。
 *
 * 存在的唯一目的：用「只加一个新文件 + 组合根一行注册」证明**加能力不需要改内核**。
 * 它是功能上的空操作——只注册一个返回常量字符串的能力，不写存储、不发请求、不产生
 * 任何行为。任何真实能力都不该照抄它的空实现，只该照抄它的装配方式。
 */

export interface SampleCapability {
  /** 空操作：给测试与诊断用，不参与任何业务路径。 */
  describe(): string;
}

export const SampleCapabilityToken = token<SampleCapability>("sample.capability");

export function sampleCapabilityPlugin(label = "sample"): AikaPlugin {
  return {
    id: "sample.capability",
    version: "1.0.0",
    provides: [SampleCapabilityToken],
    activate(context) {
      context.registrar.provide(SampleCapabilityToken, () => ({
        describe: () => label,
      }));
    },
  };
}
