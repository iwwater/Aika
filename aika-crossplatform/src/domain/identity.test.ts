import { describe, expect, it } from "vitest";
import {
  buildCapabilityMatrix, IDENTITY_CONTRACT_SCHEMA_VERSION, LOCAL_PRINCIPAL_ID,
  type AgentSessionRefV1, type ConversationV1, type DeviceSessionV1,
  type PrincipalIdentityV1, type RuntimeTurnRefV1,
} from "./identity";

describe("身份/会话契约（RT-01）", () => {
  it("六个概念各有版本化形状，runtimeTurn 引用包含 conversation/thread", () => {
    const principal: PrincipalIdentityV1 = { version: 1, principalId: "u-1", kind: "user" };
    const conversation: ConversationV1 = { version: 1, conversationId: "c-1", principalId: "u-1", createdAt: 1 };
    const turn: RuntimeTurnRefV1 = { conversationId: "c-1", threadId: "t-1", runtimeTurnId: "uuid-1" };
    const agentSession: AgentSessionRefV1 = { version: 1, sessionId: "s-1", principalId: "u-1", conversationId: "c-1" };
    const device: DeviceSessionV1 = { version: 1, deviceId: "d-1", hostEpoch: "e-1", startedAt: 1 };

    expect(conversation.principalId).toBe(principal.principalId);
    expect(turn.conversationId).toBe(conversation.conversationId);
    expect(agentSession.conversationId).toBe(conversation.conversationId);
    expect(device.hostEpoch).toBe("e-1");
    expect(IDENTITY_CONTRACT_SCHEMA_VERSION).toBe(1);
    expect(LOCAL_PRINCIPAL_ID).toBe("local");
  });
});

describe("buildCapabilityMatrix（RT-01）", () => {
  it("由插件清单投影：装了什么就是什么，没装的是 false", () => {
    const matrix = buildCapabilityMatrix("epoch-1", [
      { id: "host.core", provides: ["host.storage"] },
      { id: "llm.memory", provides: ["llm.memory", "llm.memoryAccess"] },
      { id: "llm.contextSources", provides: ["llm.contextSources"] },
      { id: "llm.runtime", provides: ["llm.runtime"] },
      { id: "llm.trace", provides: ["llm.traceRecorder"] },
      { id: "llm.usage", provides: ["llm.usageLedger"] },
    ], 1_700_000_000_000);

    expect(matrix.version).toBe(1);
    expect(matrix.hostEpoch).toBe("epoch-1");
    expect(matrix.protocolVersions).toEqual({ sourceEnvelope: 1, identityContract: 1 });
    expect(matrix.capabilities).toEqual({
      storage: true,
      memory: true,
      knowledge: true,
      runtime: true,
      trace: true,
      usageLedger: true,
      remote: false,
    });
    expect(matrix.generatedAt).toBe(1_700_000_000_000);
  });

  it("空宿主如实全 false", () => {
    const matrix = buildCapabilityMatrix("epoch-2", [], 0);
    expect(Object.values(matrix.capabilities).every((value) => value === false)).toBe(true);
  });
});
