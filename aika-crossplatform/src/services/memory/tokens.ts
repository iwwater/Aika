import { token } from "../../kernel";
import type { MemoryRepository } from "./memoryRepository";

/**
 * 记忆仓储。
 *
 * 存储没有 memoryV2 端口时这个 token **不注册**——消费方按 optional +
 * tryResolve 降级到 V1 记忆，不是拿到一个空壳仓储。
 */
export const MemoryRepositoryToken = token<MemoryRepository>("llm.memoryRepository");
